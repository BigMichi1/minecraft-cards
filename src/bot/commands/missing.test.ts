import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { db, initializeDatabase } from '../database/db';
import { cards, listingCards, listings, runs, users, wantedCards } from '../database/schema/index';
import { listingManager } from '../database/listingManager';
import { runManager } from '../database/runManager';
import { cid } from '../../test/cardIds';
import { catalogManager } from '../database/catalogManager';
import logger from '../utils/logger';
import { execute as executeWith, data } from './missing';

let replies: Array<{ content?: string; flags?: unknown; embeds?: unknown[] }> = [];

const ALL_SHOPS = { enabledShops: ['sammel-ente', 'blue-ocean', 'ebay'] } as const;
const execute = (i: ChatInputCommandInteraction) =>
  executeWith(i, { enabledShops: ['sammel-ente', 'blue-ocean'] });

function fakeInteraction(userId: string, sub: string, list?: string) {
  return {
    user: { id: userId },
    deferred: false,
    replied: false,
    commandName: 'missing',
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => sub,
      getString: (_name: string) => list ?? null,
    },
    reply: async (payload: { content?: string; flags?: unknown; embeds?: unknown[] }) => {
      replies.push(payload);
    },
  } as unknown as ChatInputCommandInteraction;
}

const lastReply = () => replies[replies.length - 1]!;

describe('/missing', () => {
  beforeAll(() => {
    initializeDatabase();
  });

  beforeEach(() => {
    replies = [];
    db.delete(listingCards).run();
    db.delete(listings).run();
    db.delete(runs).run();
    db.delete(wantedCards).run();
    db.delete(users).run();
    db.delete(cards).run();
    catalogManager.seedIfEmpty();
  });

  test('declares the six subcommands with max_length 6000 on list', () => {
    const json = data.toJSON();
    expect(json.options?.map((o) => o.name)).toEqual([
      'set',
      'add',
      'remove',
      'list',
      'clear',
      'status',
    ]);
    const set = json.options![0] as { options: Array<{ max_length?: number }> };
    expect(set.options[0]!.max_length).toBe(6000);
  });

  test('set replies with the new list, ephemeral', async () => {
    await execute(fakeInteraction('u1', 'set', '12, 45'));
    expect(lastReply().content).toBe('Your missing cards (2): 12, 45');
    expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
  });

  test('add with an unknown token changes nothing and names it', async () => {
    await execute(fakeInteraction('u1', 'set', '12, 45'));
    await execute(fakeInteraction('u1', 'add', '12, 9999'));
    expect(lastReply().content).toBe('Nothing changed. Unknown or invalid: 9999');
    expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
    await execute(fakeInteraction('u1', 'list'));
    expect(lastReply().content).toBe('Your missing cards (2): 12, 45');
  });

  test('add and remove update the list', async () => {
    await execute(fakeInteraction('u1', 'set', '12'));
    await execute(fakeInteraction('u1', 'add', '45, LE8'));
    expect(lastReply().content).toBe('Your missing cards (3): 12, 45, LE8');
    await execute(fakeInteraction('u1', 'remove', '12'));
    expect(lastReply().content).toBe('Your missing cards (2): 45, LE8');
  });

  test('empty or separator-only input gets the example hint', async () => {
    await execute(fakeInteraction('u1', 'set', ' , '));
    expect(lastReply().content).toBe('No card numbers found. Example: 12, 45, LE8');
    expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
  });

  test('list on an empty list and clear', async () => {
    await execute(fakeInteraction('u1', 'list'));
    expect(lastReply().content).toBe('You have no missing cards on your list.');
    await execute(fakeInteraction('u1', 'set', '12'));
    await execute(fakeInteraction('u1', 'clear'));
    expect(lastReply().content).toBe('Your missing list is now empty.');
    expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
    await execute(fakeInteraction('u1', 'list'));
    expect(lastReply().content).toBe('You have no missing cards on your list.');
  });

  test('a huge invalid list is truncated to fit Discord and names the remainder', async () => {
    const tokens = Array.from({ length: 1500 }, (_, i) => `bad${i}`);
    await execute(fakeInteraction('u1', 'set', tokens.join(', ')));
    const content = lastReply().content!;
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content.startsWith('Nothing changed. Unknown or invalid: ')).toBe(true);
    const m = content.match(/… and (\d+) more$/);
    expect(m).not.toBeNull();
    const shown = content
      .slice('Nothing changed. Unknown or invalid: '.length, m!.index)
      .trim()
      .split(', ');
    expect(shown.length + Number(m![1])).toBe(1500);
    expect(shown[0]).toBe('bad0');
  });

  test('duplicate invalid tokens appear once', async () => {
    await execute(fakeInteraction('u1', 'add', '9999, 9999, abc, 9999'));
    expect(lastReply().content).toBe('Nothing changed. Unknown or invalid: abc, 9999');
  });
  test('status shows the last check and each card with its shop state, ephemeral', async () => {
    const T = 1_800_000_000_000;
    await execute(fakeInteraction('u1', 'set', '12'));
    listingManager.upsertFromRun(
      'sammel-ente',
      [
        {
          shop: 'sammel-ente',
          url: 'https://shop-sammel-ente.de/x/MNC-03XX-BAS-0012',
          title: 'LEGO Minecraft Serie 3 | #012 Squid',
          cardIds: [cid('12')],
          cardName: 'Squid',
          imageUrl: null,
          price: { cents: 55, currency: 'EUR' },
          available: true,
          format: 'shop',
          auctionEndsAt: null,
          idConflict: false,
        },
      ],
      T
    );
    runManager.record({
      startedAt: T,
      finishedAt: T + 1,
      shops: { 'sammel-ente': { listings: 1 } },
      notified: 0,
      dmFailures: 0,
    });
    await execute(fakeInteraction('u1', 'status'));
    expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
    expect(lastReply().content).toContain(`Your missing cards (1) · last check <t:${T / 1000}:R>`);
    expect(lastReply().content).toMatch(/\n#12 +0,55 €¹ +\? +n\/a +n\/a\n/);
    const embed = (lastReply().embeds![0] as { toJSON(): { description?: string } }).toJSON();
    expect(embed.description).toBe(
      '¹ [#12 · sammel-ente · 0,55 €](https://shop-sammel-ente.de/x/MNC-03XX-BAS-0012)'
    );
  });

  test('status on an empty list', async () => {
    await execute(fakeInteraction('u1', 'status'));
    expect(lastReply().content).toBe('You have no missing cards on your list.');
  });

  test('status marks a failed shop as of its older last success', async () => {
    const now = Date.now();
    const older = now - 3 * 60 * 60 * 1000;
    const newer = now - 60 * 60 * 1000;
    catalogManager.updateNamesAndReferences([{ cardId: cid('12'), name: 'Squid', imageUrl: null }]);
    await execute(fakeInteraction('u1', 'set', '12'));
    listingManager.upsertFromRun(
      'blue-ocean',
      [
        {
          shop: 'blue-ocean',
          url: 'https://www.blue-ocean.de/x-tcc-12',
          title: 'On Fire 12',
          cardIds: [cid('12')],
          cardName: null,
          imageUrl: null,
          price: { cents: 90, currency: 'EUR' },
          available: true,
          format: 'shop',
          auctionEndsAt: null,
          idConflict: false,
        },
      ],
      older
    );
    const base = { notified: 0, dmFailures: 0 };
    runManager.record({
      ...base,
      startedAt: older,
      finishedAt: older + 1,
      shops: { 'sammel-ente': { listings: 1 }, 'blue-ocean': { listings: 1 } },
    });
    runManager.record({
      ...base,
      startedAt: newer,
      finishedAt: newer + 1,
      shops: { 'sammel-ente': { listings: 1 }, 'blue-ocean': { listings: 0, error: 'down' } },
    });
    await execute(fakeInteraction('u1', 'status'));
    expect(lastReply().content).toContain(`data as of <t:${Math.floor(older / 1000)}:R>`);
    expect(lastReply().content).toMatch(/\n#12 Squid +– +0,90 € ⏱⚠¹ +n\/a +n\/a\n/);
  });

  test('status shows a shop that is not enabled and skips its listings', async () => {
    const now = Date.now();
    await execute(fakeInteraction('u1', 'set', '12'));
    runManager.record({
      startedAt: now,
      finishedAt: now + 1,
      shops: { 'sammel-ente': { listings: 1 }, 'blue-ocean': { listings: 1 } },
      notified: 0,
      dmFailures: 0,
    });
    await execute(fakeInteraction('u1', 'status'));
    expect(lastReply().content).toContain('⚪ eBay: not enabled');
    expect(lastReply().content).toMatch(/\n#12 +– +– +n\/a +n\/a\n/);
    expect(lastReply().embeds).toEqual([]);
    await executeWith(fakeInteraction('u1', 'status'), ALL_SHOPS);
    expect(lastReply().content).toContain('⚠️ eBay: not checked');
    expect(lastReply().content).toMatch(/\n#12 +– +– +n\/a +\?\n/);
  });

  test('status that fails has its own error text and logs the subcommand', async () => {
    await execute(fakeInteraction('u1', 'set', '12'));
    const read = spyOn(runManager, 'latestReadable').mockImplementation(() => {
      throw new Error('db locked');
    });
    const log = spyOn(logger, 'log').mockImplementation(() => logger);
    try {
      await execute(fakeInteraction('u1', 'status'));
      const embed = (lastReply().embeds![0] as { toJSON(): { description?: string } }).toJSON();
      expect(embed.description).toBe('Could not load your stock status. Please try again later.');
      expect(log.mock.calls.some((c) => String(c[1]).includes('/missing status failed'))).toBe(
        true
      );
    } finally {
      read.mockRestore();
      log.mockRestore();
    }
  });
});
