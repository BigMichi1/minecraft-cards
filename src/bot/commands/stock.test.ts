import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import { db, initializeDatabase } from '../database/db';
import { cards, listingCards, listings, runs, users, wantedCards } from '../database/schema/index';
import { catalogManager } from '../database/catalogManager';
import { listingManager } from '../database/listingManager';
import { runManager } from '../database/runManager';
import { userManager } from '../database/userManager';
import { compareCardIds } from '../cards/cardId';
import { cid } from '../../test/cardIds';
import { runOf, storedListing as listing } from '../../test/listings';
import logger from '../utils/logger';
import { data, execute, handleStockButton } from './stock';

const CTX = { enabledShops: ['sammel-ente', 'blue-ocean'] } as const;

type Payload = {
  content?: string;
  flags?: unknown;
  embeds?: { toJSON(): { description?: string } }[];
  components?: { toJSON(): { components: { custom_id: string; disabled: boolean }[] } }[];
};

let replies: Payload[] = [];
let updates: Payload[] = [];

function command(userId: string, only: string | null, collection: string = 'lego-minecraft-3') {
  return {
    user: { id: userId },
    deferred: false,
    replied: false,
    commandName: 'stock',
    isChatInputCommand: () => true,
    options: {
      getString: (name: string) =>
        name === 'only' ? only : name === 'collection' ? collection : null,
    },
    reply: async (p: Payload) => {
      replies.push(p);
    },
  } as unknown as ChatInputCommandInteraction;
}

function button(userId: string, customId: string) {
  return {
    user: { id: userId },
    customId,
    deferred: false,
    replied: false,
    isChatInputCommand: () => false,
    reply: async (p: Payload) => {
      replies.push(p);
    },
    update: async (p: Payload) => {
      updates.push(p);
    },
  } as unknown as ButtonInteraction;
}

const ids = (p: Payload) =>
  (p.components ?? []).flatMap((r) => r.toJSON().components.map((c) => c.custom_id));
const first = (p: Payload) => p.content!.split('\n')[0];

describe('/stock', () => {
  beforeAll(() => {
    initializeDatabase();
  });

  beforeEach(() => {
    replies = [];
    updates = [];
    db.delete(listingCards).run();
    db.delete(listings).run();
    db.delete(runs).run();
    db.delete(wantedCards).run();
    db.delete(users).run();
    db.delete(cards).run();
    catalogManager.seedIfEmpty();
    runManager.record(runOf(['sammel-ente', 'blue-ocean']));
  });

  test('declares the only option with its three choices', () => {
    const json = data.toJSON();
    expect(json.name).toBe('stock');
    expect(json.options![0]).toMatchObject({ name: 'collection', required: true });
    const only = json.options![1] as {
      name: string;
      required?: boolean;
      choices: { value: string }[];
    };
    expect(only.name).toBe('only');
    expect(only.required).toBeFalsy();
    expect(only.choices.map((c) => c.value)).toEqual(['all', 'missing', 'in-stock']);
  });

  test('an unknown collection is refused before anything is read', async () => {
    await execute(command('u1', null, 'lego-minecraft-9'), CTX);
    expect(replies).toEqual([{ content: 'Unknown collection.', flags: MessageFlags.Ephemeral }]);
  });

  test('a paging button of another collection is refused', async () => {
    await handleStockButton(button('u1', 'stock:lego-minecraft-9:2:all'), CTX);
    expect(updates).toEqual([]);
    expect(replies[0]!.content).toBe('This button is not valid.');
  });

  test('without a filter: page 1 of the whole catalog, ephemeral, with paging buttons', async () => {
    await execute(command('u1', null), CTX);
    const reply = replies[0]!;
    expect(reply.flags).toBe(MessageFlags.Ephemeral);
    expect(first(reply)).toMatch(/^Stock · all cards \(251\) · page 1\/\d+$/);
    expect(reply.content!.length).toBeLessThanOrEqual(2000);
    expect(reply.content).toMatch(/\n1 +- +- +n\/a +n\/a\n/);
    expect(ids(reply)).toEqual(['stock:lego-minecraft-3:1:all', 'stock:lego-minecraft-3:2:all']);
  });

  test('a failed shop shows when its data is from', async () => {
    runManager.record(runOf(['sammel-ente'], ['blue-ocean']));
    await execute(command('u1', null), CTX);
    expect(replies[0]!.content!.split('\n')[1]).toMatch(
      /❌ blue-ocean failed, as of <t:\d+:R> · ⚪ collect-it n\/a/
    );
  });

  test('an unknown only value falls back to all', async () => {
    await execute(command('u1', 'bogus'), CTX);
    expect(first(replies[0]!)).toMatch(/^Stock · all cards \(251\) · page 1\/\d+$/);
  });

  test('a shop without a success in the window says so', async () => {
    db.delete(runs).run();
    runManager.record(runOf(['sammel-ente'], ['blue-ocean']));
    await execute(command('u1', null), CTX);
    expect(replies[0]!.content!.split('\n')[1]).toContain(
      '❌ blue-ocean failed, no success in 7 days'
    );
  });

  test('stock:2:in-stock pages through a catalog-sized in-stock set', async () => {
    const inStock = [...catalogManager.knownIds('lego-minecraft-3')]
      .sort(compareCardIds)
      .slice(0, 150);
    const stored = inStock.map((card) => listing('sammel-ente', [card]));
    const read = spyOn(listingManager, 'listingsForCards').mockImplementation(() => stored);
    try {
      await handleStockButton(button('u1', 'stock:2:in-stock'), CTX);
    } finally {
      read.mockRestore();
    }
    const page = updates[0]!;
    expect(first(page)).toMatch(/^Stock · cards in stock \(150\) · page 2\/[3-9]$/);
    const rows = page.content!.split('\n').filter((l) => /^\w+ +[x-] /.test(l));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => /^\w+ +x /.test(r))).toBe(true);
    // Page 2 starts right after page 1's last card.
    expect(rows[0]!.split(' ')[0]).toBe(String(inStock[rows.length]));
    expect(ids(page)).toEqual([
      'stock:lego-minecraft-3:1:in-stock',
      'stock:lego-minecraft-3:3:in-stock',
    ]);
  });

  test('a stale click on a list that shrank shows its last page', async () => {
    userManager.setList('u1', 'lego-minecraft-3', '1-228, LE1-LE22, XXL1');
    await handleStockButton(button('u1', 'stock:9:missing'), CTX);
    expect(first(updates[0]!)).toMatch(/^Stock · your missing cards \(251\) · page (\d+)\/\1$/);
    userManager.setList('u1', 'lego-minecraft-3', '12, 45');
    await handleStockButton(button('u1', 'stock:9:missing'), CTX);
    expect(first(updates[1]!)).toBe('Stock · your missing cards (2) · page 1/1');
    expect(updates[1]!.components).toEqual([]);
  });

  test('a stored in-stock listing shows as x', async () => {
    const stored = listing('sammel-ente', [cid('1')]);
    const read = spyOn(listingManager, 'listingsForCards').mockImplementation(() => [stored]);
    try {
      await execute(command('u1', 'in-stock'), CTX);
    } finally {
      read.mockRestore();
    }
    expect(first(replies[0]!)).toBe('Stock · cards in stock (1) · page 1/1');
    expect(replies[0]!.content).toMatch(/\n1 +x +- +n\/a +n\/a\n/);
    expect(replies[0]!.components).toEqual([]);
  });

  test('only:missing uses the list of the user who runs it', async () => {
    userManager.setList('u1', 'lego-minecraft-3', '12, LE8');
    await execute(command('u1', 'missing'), CTX);
    expect(first(replies[0]!)).toBe('Stock · your missing cards (2) · page 1/1');
    await execute(command('u2', 'missing'), CTX);
    expect(replies[1]!.content).toBe('You have no missing cards on your list.');
  });

  test('a ▶ click updates the message in place with the next page', async () => {
    await handleStockButton(button('u1', 'stock:2:all'), CTX);
    expect(replies).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(first(updates[0]!)).toMatch(/· page 2\/\d+$/);
    expect(ids(updates[0]!)).toEqual([
      'stock:lego-minecraft-3:1:all',
      'stock:lego-minecraft-3:3:all',
    ]);
  });

  test('a click re-reads the data: a card that sold out since drops from in-stock', async () => {
    const stored = listing('sammel-ente', [cid('1')]);
    const read = spyOn(listingManager, 'listingsForCards').mockImplementation(() => [stored]);
    try {
      await handleStockButton(button('u1', 'stock:1:in-stock'), CTX);
      stored.available = false;
      await handleStockButton(button('u1', 'stock:1:in-stock'), CTX);
    } finally {
      read.mockRestore();
    }
    expect(first(updates[0]!)).toBe('Stock · cards in stock (1) · page 1/1');
    expect(updates[1]!.content).toBe('No card is in stock in any enabled shop right now.');
  });

  test('a missing-list click pages the list of the user who clicks', async () => {
    userManager.setList('u2', 'lego-minecraft-3', '45');
    await handleStockButton(button('u2', 'stock:1:missing'), CTX);
    expect(first(updates[0]!)).toBe('Stock · your missing cards (1) · page 1/1');
  });

  test('an invalid custom id is refused without reading or updating anything', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => logger);
    const read = spyOn(runManager, 'latestReadable');
    try {
      await handleStockButton(button('u1', 'stock:0:all'), CTX);
      await handleStockButton(button('u1', 'stock:1:everything'), CTX);
      expect(read).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      read.mockRestore();
    }
    expect(updates).toEqual([]);
    expect(replies.map((r) => [r.content, r.flags])).toEqual([
      ['This button is not valid.', MessageFlags.Ephemeral],
      ['This button is not valid.', MessageFlags.Ephemeral],
    ]);
  });

  describe('errors', () => {
    let log: ReturnType<typeof spyOn>;
    let read: ReturnType<typeof spyOn>;
    beforeEach(() => {
      log = spyOn(logger, 'log').mockImplementation(() => logger);
      read = spyOn(runManager, 'latestReadable').mockImplementation(() => {
        throw new Error('db locked');
      });
    });
    afterEach(() => {
      log.mockRestore();
      read.mockRestore();
    });

    test('the command answers with an error reply and logs', async () => {
      await execute(command('u1', null), CTX);
      expect(replies[0]!.embeds![0]!.toJSON().description).toBe(
        'Could not load the stock table. Please try again later.'
      );
      expect(log.mock.calls.some((c: unknown[]) => String(c[1]).includes('/stock failed'))).toBe(
        true
      );
    });

    test('a click answers with an error reply and logs', async () => {
      await handleStockButton(button('u1', 'stock:2:all'), CTX);
      expect(updates).toEqual([]);
      expect(replies[0]!.embeds![0]!.toJSON().description).toBe(
        'Could not load the stock table. Please try again later.'
      );
      expect(log.mock.calls.some((c: unknown[]) => String(c[1]).includes('stock:2:all'))).toBe(
        true
      );
    });
  });
});
