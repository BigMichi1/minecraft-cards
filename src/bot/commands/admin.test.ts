import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
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
import { data, execute as adminExecute, type AdminContext } from './admin';

const blue12: Listing = {
  shop: 'blue-ocean',
  url: 'https://www.blue-ocean.de/p/12',
  title: 'Sticker Card 12',
  cardIds: ['12'],
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
    ebay: { listings: 5, skippedNoId: 2 },
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
      getString: (name: string) => opts[name] ?? null,
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
    listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
    await adminExecute(fakeAdmin(undefined, 'map', { url: blue12.url, cards: '8' }), ctx);
    expect(listingManager.getByUrl(blue12.url)!.cardIds).toEqual(['8']);
    expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
  });

  test('map with an unknown card or URL changes nothing', async () => {
    listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
    await adminExecute(fakeAdmin(undefined, 'map', { url: blue12.url, cards: '8, 9999' }), ctx);
    expect(lastReply().content).toBe('Nothing changed. Unknown or invalid: 9999');
    expect(listingManager.getByUrl(blue12.url)!.cardIds).toEqual(['12']);
    await adminExecute(fakeAdmin(undefined, 'map', { url: 'https://nope', cards: '8' }), ctx);
    expect(lastReply().content).toBe('No stored listing with that URL.');
  });

  test('clear lifts the hold', async () => {
    const [stored] = listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
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
    expect(text).toContain('ebay: 5 listings (skipped 2 without card number)');
    expect(text).toContain('Notified: 4 · DM failures: 1');
  });

  test('status lists the listings on hold, up to 10', async () => {
    await adminExecute(fakeAdmin(undefined, 'status'), ctx);
    expect(lastReply().content).not.toContain('On hold');
    const stored = listingManager.upsertFromRun(
      'blue-ocean',
      Array.from({ length: 12 }, (_, i) => ({
        ...blue12,
        url: `https://www.blue-ocean.de/p/${i + 1}`,
        cardIds: i === 0 ? ['12', 'LE8'] : [String(i + 1)],
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
      expect(catalogManager.knownIds().has('LE23')).toBe(false);
    });

    test('lists what is still wanted when ids are removed', async () => {
      userManager.setList('u1', 'LE22');
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
      expect(catalogManager.knownIds().size).toBeGreaterThan(200);
    });

    test('an oversized preview stays within 2000 characters', async () => {
      const big = Array.from({ length: 1500 }, (_, i) => String(i + 1000)).join(', ');
      await adminExecute(fakeAdmin('catalog', 'import', { list: big }), ctx);
      expect(lastReply().content!.length).toBeLessThanOrEqual(2000);
    });
  });
});
