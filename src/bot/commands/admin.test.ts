import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { STARTER_CHECKLIST } from '../cards/starterCatalog';
import type { RunSummary } from '../check/runner';
import { catalogManager } from '../database/catalogManager';
import { db, initializeDatabase } from '../database/db';
import { listingManager } from '../database/listingManager';
import { runManager } from '../database/runManager';
import {
  adminAlerts,
  cards,
  listingCards,
  listings,
  notifications,
  reports,
  runs,
  users,
  wantedCards,
} from '../database/schema/index';
import { userManager } from '../database/userManager';
import type { Listing } from '../shops/types';
import logger from '../utils/logger';
import { data, execute as adminExecute, formatSummary, type AdminContext } from './admin';
import { importStore } from '../interactions/catalogImport';
import type { CollectionId } from '../collections/ids';
import { cid, ids } from '../../test/cardIds';

const blue12: Listing = {
  shop: 'blue-ocean',
  url: 'https://www.blue-ocean.de/p/12',
  title: 'Sticker Card 12',
  cardIds: [cid('12')],
  cardName: null,
  imageUrl: 'https://img/12.jpg',
  price: { cents: 199, currency: 'EUR' },
  available: true,
  format: 'shop',
  auctionEndsAt: null,
  idConflict: false,
};

const summary: RunSummary = {
  startedAt: 1_000,
  finishedAt: 1_700_000_000_000,
  shops: {
    'blue-ocean': { listings: 3 },
    'sammel-ente': { listings: 0, error: 'boom' },
    ebay: { listings: 5, skippedNoId: 2, skippedExcluded: 7, truncated: 1 },
  },
  notified: 4,
  dmFailures: 1,
};

let replies: Array<{ content?: string; flags?: unknown; components?: unknown[] }> = [];
let deferred = 0;

function fake(
  userId: string,
  group: string | undefined,
  sub: string,
  opts: Record<string, string> = {}
) {
  const self = {
    user: { id: userId },
    deferred: false,
    replied: false,
    commandName: 'admin',
    isChatInputCommand: () => true,
    options: {
      getSubcommandGroup: () => group ?? null,
      getSubcommand: () => sub,
      getString: (name: string) =>
        opts[name] ?? (name === 'collection' ? 'lego-minecraft-3' : null),
    },
    reply: async (p: any) => {
      replies.push(p);
      self.replied = true;
    },
    deferReply: async (p: any) => {
      deferred++;
      self.deferred = true;
      expect(p.flags).toBe(MessageFlags.Ephemeral);
    },
    editReply: async (p: any) => {
      replies.push(p);
    },
  };
  return self as unknown as ChatInputCommandInteraction;
}
const fakeAdmin = (group: string | undefined, sub: string, opts?: Record<string, string>) =>
  fake('admin', group, sub, opts);
const lastReply = () => replies[replies.length - 1]!;

let ctx: AdminContext;

describe('/admin', () => {
  beforeAll(() => {
    initializeDatabase();
  });

  beforeEach(() => {
    replies = [];
    deferred = 0;
    for (const t of [
      notifications,
      reports,
      listingCards,
      listings,
      wantedCards,
      users,
      runs,
      adminAlerts,
      cards,
    ]) {
      db.delete(t).run();
    }
    catalogManager.seedIfEmpty();
    ctx = { adminId: 'admin', trigger: async () => summary };
  });

  test('declares map, clear, status, run and the catalog import group', () => {
    const json = data.toJSON();
    expect(json.options?.map((o) => o.name)).toEqual(['map', 'clear', 'status', 'run', 'catalog']);
  });

  test('is hidden from members without the Administrator permission', () => {
    expect(data.toJSON().default_member_permissions).toBe(
      PermissionFlagsBits.Administrator.toString()
    );
  });

  test('map without any card number says how to write one and changes nothing', async () => {
    await adminExecute(fakeAdmin(undefined, 'map', { url: 'https://x', cards: ' , ' }), ctx);
    expect(lastReply().content).toBe('No card numbers found. Example: 12, LE8');
  });

  test('an unknown subcommand is answered with an error, not thrown', async () => {
    await adminExecute(fakeAdmin(undefined, 'nope'), ctx);
    expect((lastReply() as any).embeds[0].toJSON().description).toBe(
      'Something went wrong running the admin command.'
    );
  });

  test('non-admins are refused and nothing runs', async () => {
    let triggered = false;
    ctx.trigger = async () => {
      triggered = true;
      return summary;
    };
    await adminExecute(fake('u1', undefined, 'status'), ctx);
    expect(lastReply().content).toBe('Only the bot admin can use this.');
    expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
    await adminExecute(fake('u1', undefined, 'run'), ctx);
    expect(lastReply().content).toBe('Only the bot admin can use this.');
    expect(triggered).toBe(false);
    expect(deferred).toBe(0);
  });

  test('map overrides the cards of a listing', async () => {
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
    await adminExecute(fakeAdmin(undefined, 'map', { url: blue12.url, cards: '8' }), ctx);
    expect(listingManager.getByUrl(blue12.url)!.cardIds).toEqual([cid('8')]);
    expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
  });

  test('map takes the collection first and passes it on', async () => {
    const map = (data.toJSON().options as unknown as { name: string; options: unknown[] }[]).find(
      (o) => o.name === 'map'
    )!;
    expect(map.options[0]).toMatchObject({ name: 'collection', required: true });
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
    const spy = spyOn(listingManager, 'overrideCards');
    try {
      await adminExecute(
        fakeAdmin(undefined, 'map', {
          url: blue12.url,
          cards: '8',
          collection: 'lego-minecraft-3',
        }),
        ctx
      );
      expect(spy.mock.calls[0]!.slice(0, 2)).toEqual([
        blue12.url,
        { collection: 'lego-minecraft-3', ids: ids('8') },
      ]);
      expect(lastReply().content).toBe('Listing now maps to LEGO Minecraft Serie 3 "On Fire": 8');
    } finally {
      spy.mockRestore();
    }
  });

  test('map refuses to move a listing to another collection, naming the one it is in', async () => {
    listingManager.upsertFromRun('blue-ocean', 'other-set' as CollectionId, [blue12], 1000);
    await adminExecute(fakeAdmin(undefined, 'map', { url: blue12.url, cards: '8' }), ctx);
    expect(lastReply().content).toBe(
      'Nothing changed: the listing is in collection other-set; moving a listing to another collection is not supported yet.'
    );
    expect(listingManager.getByUrl(blue12.url)).toMatchObject({
      collection: 'other-set',
      cardIds: ids('12'),
      manualOverride: false,
    });
  });

  test('catalog import previews and stores the chosen collection', async () => {
    const put = spyOn(importStore, 'put');
    const preview = spyOn(catalogManager, 'previewImport');
    try {
      await adminExecute(fakeAdmin('catalog', 'import', { list: '1, 2' }), ctx);
      expect(put.mock.calls[0]).toEqual(['lego-minecraft-3', ids('1', '2')]);
      expect(preview.mock.calls[0]).toEqual([
        { collection: 'lego-minecraft-3', ids: ids('1', '2') },
      ]);
      expect(lastReply().content).toStartWith('Collection: LEGO Minecraft Serie 3 "On Fire"\n');
    } finally {
      put.mockRestore();
      preview.mockRestore();
    }
  });

  test('map and catalog import with an unknown collection change nothing', async () => {
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
    await adminExecute(
      fakeAdmin(undefined, 'map', { url: blue12.url, cards: '8', collection: 'lego-minecraft-9' }),
      ctx
    );
    expect(lastReply()).toEqual({ content: 'Unknown collection.', flags: MessageFlags.Ephemeral });
    expect(listingManager.getByUrl(blue12.url)!.cardIds).toEqual([cid('12')]);
    await adminExecute(
      fakeAdmin('catalog', 'import', { list: '1, 2', collection: 'lego-minecraft-9' }),
      ctx
    );
    expect(lastReply()).toEqual({ content: 'Unknown collection.', flags: MessageFlags.Ephemeral });
  });

  test('map with an unknown card or URL changes nothing', async () => {
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
    await adminExecute(fakeAdmin(undefined, 'map', { url: blue12.url, cards: '8, 9999' }), ctx);
    expect(lastReply().content).toBe('Nothing changed. Unknown or invalid: 9999');
    expect(listingManager.getByUrl(blue12.url)!.cardIds).toEqual([cid('12')]);
    await adminExecute(fakeAdmin(undefined, 'map', { url: 'https://nope', cards: '8' }), ctx);
    expect(lastReply().content).toBe('No stored listing with that URL.');
  });

  test('clear lifts the hold', async () => {
    const [stored] = listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
    listingManager.setOnHold(stored!.id);
    await adminExecute(fakeAdmin(undefined, 'clear', { url: blue12.url }), ctx);
    expect(listingManager.getByUrl(blue12.url)!.onHold).toBe(false);
    await adminExecute(fakeAdmin(undefined, 'clear', { url: 'https://nope' }), ctx);
    expect(lastReply().content).toBe('No stored listing with that URL.');
  });

  test('status without a run, then with one', async () => {
    await adminExecute(fakeAdmin(undefined, 'status'), ctx);
    expect(lastReply().content).toBe('No check has run yet.');
    runManager.record(summary);
    await adminExecute(fakeAdmin(undefined, 'status'), ctx);
    const text = lastReply().content!;
    expect(text).toContain('<t:1700000000:R>');
    expect(text).toContain('blue-ocean: 3 listings');
    expect(text).toContain('sammel-ente: 0 listings — error: boom');
    expect(text).toContain(
      'ebay: 5 listings (skipped 2 without card number) (skipped 7 not series 3 single cards) (1 search cut at the page cap)'
    );
    expect(text).toContain('Notified: 4 · DM failures: 1');
  });

  test('status with a stored run whose shop entries are corrupt does not throw', async () => {
    const warn = spyOn(logger, 'warn');
    try {
      db.insert(runs)
        .values({
          startedAt: 1_700_000_000_000,
          finishedAt: 1_700_000_001_000,
          summary: JSON.stringify({
            ...summary,
            shops: { 'blue-ocean': null, ebay: { listings: 5 } },
          }),
        })
        .run();
      await adminExecute(fakeAdmin(undefined, 'status'), ctx);
      const text = lastReply().content!;
      expect(text).toContain('ebay: 5 listings');
      expect(text).not.toContain('blue-ocean');
    } finally {
      warn.mockRestore();
    }
  });

  test('status lists the listings on hold, up to 10', async () => {
    await adminExecute(fakeAdmin(undefined, 'status'), ctx);
    expect(lastReply().content).not.toContain('On hold');
    const stored = listingManager.upsertFromRun(
      'blue-ocean',
      'lego-minecraft-3',
      Array.from({ length: 12 }, (_, i) => ({
        ...blue12,
        url: `https://www.blue-ocean.de/p/${i + 1}`,
        cardIds: i === 0 ? ids('12', 'LE8') : [cid(String(i + 1))],
      })),
      1000
    );
    for (const l of stored) listingManager.setOnHold(l.id);
    await adminExecute(fakeAdmin(undefined, 'status'), ctx);
    const text = lastReply().content!;
    expect(text).toContain('No check has run yet.');
    expect(text).toContain('On hold: 12 listings');
    expect(text).toContain('https://www.blue-ocean.de/p/1 (#12, #LE8)');
    expect(text).toContain('https://www.blue-ocean.de/p/10 (#10)');
    expect(text).not.toContain('https://www.blue-ocean.de/p/11 ');
    expect(text).toContain('… and 2 more');
  });

  test('status with long held URLs stays within 2000 characters', async () => {
    runManager.record(summary);
    const stored = listingManager.upsertFromRun(
      'blue-ocean',
      'lego-minecraft-3',
      Array.from({ length: 10 }, (_, i) => ({
        ...blue12,
        url: `https://www.blue-ocean.de/${String(i).repeat(400)}`,
      })),
      1000
    );
    for (const l of stored) listingManager.setOnHold(l.id);
    await adminExecute(fakeAdmin(undefined, 'status'), ctx);
    const text = lastReply().content!;
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain('On hold: 10 listings');
    expect(text).toContain('Notified: 4 · DM failures: 1');
    expect(text).toMatch(/… and \d+ more$/);
  });

  test('run defers, then edits in the summary; busy is reported', async () => {
    await adminExecute(fakeAdmin(undefined, 'run'), ctx);
    expect(deferred).toBe(1);
    expect(lastReply().content).toContain('Notified: 4 · DM failures: 1');
    ctx.trigger = async () => 'busy';
    await adminExecute(fakeAdmin(undefined, 'run'), ctx);
    expect(lastReply().content).toBe('A check is already running.');
    ctx.trigger = async () => 'stopping';
    await adminExecute(fakeAdmin(undefined, 'run'), ctx);
    expect(lastReply().content).toBe('The bot is shutting down; no check was started.');
  });

  test('a check that rejects after the deferral is one edit naming the error', async () => {
    const log = spyOn(logger, 'log');
    try {
      ctx.trigger = async () => {
        throw new Error('database is locked');
      };
      await adminExecute(fakeAdmin(undefined, 'run'), ctx);
      expect(deferred).toBe(1);
      expect(replies).toEqual([{ content: 'Check failed: database is locked' }]);
      const call = (log.mock.calls as unknown[][]).find((c) => String(c[1]).includes('/admin run'));
      expect(call?.[2]).toHaveProperty('stack');
    } finally {
      log.mockRestore();
    }
  });

  test('the summary names skipped invalid items and a failed run', () => {
    expect(
      formatSummary({
        ...summary,
        shops: { ebay: { listings: 1, skippedInvalid: 3 } },
        error: 'gateway gone',
      })
    ).toBe(
      'ebay: 1 listings (skipped 3 without link or title)\nRun failed: gateway gone\nNotified: 4 · DM failures: 1'
    );
  });

  test('the summary counts the picture decisions and the rejected ones (R9)', () => {
    expect(
      formatSummary({
        ...summary,
        shops: { ebay: { listings: 1 } },
        pictures: { decided: 3, undecided: 5, puzzle: 1, incomplete: 2 },
      })
    ).toBe(
      'ebay: 1 listings\nPictures: 3 decided · not counted: 5 undecided, 1 puzzle, 2 incomplete reference set\nNotified: 4 · DM failures: 1'
    );
  });

  describe('catalog import', () => {
    const header = 'Prüfliste für Nummern diese Sammlung:\n';
    const withLE23 = `${STARTER_CHECKLIST}, LE23`;

    test('previews additions with save/cancel buttons and stores nothing yet', async () => {
      await adminExecute(fakeAdmin('catalog', 'import', { list: header + withLE23 }), ctx);
      expect(lastReply().content).toContain('Catalog: 228 base, 23 LE, 1 XXL.');
      expect(lastReply().content).toContain('Added: LE23');
      expect(lastReply().content).toContain('Removed: none');
      expect(lastReply().components).toHaveLength(1);
      expect(catalogManager.knownIds('lego-minecraft-3').has(cid('LE23'))).toBe(false);
    });

    test('lists what is still wanted when ids are removed', async () => {
      userManager.setList('u1', 'lego-minecraft-3', 'LE22');
      const without = STARTER_CHECKLIST.replace(/LE22,?\s*/, '').replace(/,\s*$/, '');
      await adminExecute(fakeAdmin('catalog', 'import', { list: without }), ctx);
      expect(lastReply().content).toContain('Removed: LE22');
      expect(lastReply().content).toContain("Still on someone's list: LE22 (1 user)");
    });

    test('an invalid token stores nothing and is named', async () => {
      await adminExecute(fakeAdmin('catalog', 'import', { list: '1, 2, banana' }), ctx);
      expect(lastReply().content).toContain('banana');
      expect(lastReply().components).toBeUndefined();
    });

    test('zero ids reply that nothing changed', async () => {
      await adminExecute(fakeAdmin('catalog', 'import', { list: '' }), ctx);
      expect(lastReply().content).toBe('No card ids found. Nothing changed.');
      await adminExecute(fakeAdmin('catalog', 'import', { list: header.trim() }), ctx);
      expect(lastReply().content).toBe('No card ids found. Nothing changed.');
      expect(catalogManager.knownIds('lego-minecraft-3').size).toBeGreaterThan(200);
    });

    test('an oversized preview stays within 2000 characters', async () => {
      const big = Array.from({ length: 1500 }, (_, i) => String(i + 1000)).join(', ');
      await adminExecute(fakeAdmin('catalog', 'import', { list: big }), ctx);
      expect(lastReply().content!.length).toBeLessThanOrEqual(2000);
    });
  });
});
