import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { db, initializeDatabase } from '../database/db';
import { catalogManager } from '../database/catalogManager';
import { listingManager } from '../database/listingManager';
import { cards, catalogSyncs, users, wantedCards } from '../database/schema/index';
import type { AlertFn } from '../check/adminAlert';
import type { CollectionDefinition, CollectionId } from '../collections/ids';
import { legoMinecraft2 } from '../collections/legoMinecraft2';
import { legoMinecraft3 } from '../collections/legoMinecraft3';
import { parseChecklist, STARTER_CHECKLIST } from '../cards/starterCatalog';
import { MINECRAFT_CARD_IDS, TURBO_ATTAX_CARD_IDS } from '../cards/cardId';
import { turboAttax2026 } from '../collections/turboAttax2026';
import { readFixture } from '../../test/shopHelpers';
import { fetchLaststickerSet } from './laststicker';
import { HttpError } from '../utils/http';
import { cid, ids } from '../../test/cardIds';
import { CatalogLayoutError, type LaststickerRow } from './laststicker';
import {
  createSyncGate,
  formatSyncOutcome,
  SYNC_EVERY_MS,
  SYNC_SLACK_MS,
  syncCatalogs,
} from './sync';

const DAY = SYNC_EVERY_MS;
const starter = parseChecklist(STARTER_CHECKLIST, MINECRAFT_CARD_IDS).ids;
const row = (id: string, name = `Card ${id}`): LaststickerRow => ({
  cardId: cid(id),
  name,
  kind: 'Characterkarten',
  variant: 'Basis Karte',
  puzzle: false,
  pictureUrl: `https://www.laststicker.com/i/cards/12125/${id.toLowerCase()}.jpg`,
});

describe('syncCatalogs', () => {
  let alerts: { key: string; text: string }[];
  let outcome: 'sent' | 'throttled' | 'failed';
  let gate: ReturnType<typeof createSyncGate>;
  let fetched: string[];
  let sleeps: number[];
  let rows: LaststickerRow[];
  const alert: AlertFn = async (key, text) => {
    alerts.push({ key, text });
    return outcome;
  };
  const fetchSet = async (set: string) => {
    fetched.push(set);
    return { setId: 12125, rows };
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  const run = (now: number, over: Partial<Parameters<typeof syncCatalogs>[0]> = {}) =>
    // Series 3 only unless a test names others: the fake page is the series 3 checklist.
    syncCatalogs({
      now: () => now,
      alert,
      fetchSet,
      sleep,
      gate,
      collections: [legoMinecraft3],
      ...over,
    });

  beforeAll(() => initializeDatabase());
  beforeEach(() => {
    for (const t of [wantedCards, users, cards, catalogSyncs]) db.delete(t).run();
    catalogManager.seedIfEmpty();
    alerts = [];
    outcome = 'sent';
    gate = createSyncGate();
    fetched = [];
    sleeps = [];
    rows = starter.map((id) => row(id));
  });

  test("a sync that changed scans compares those cards' mismatches again", async () => {
    await run(10);
    rows = rows.map((r) => (r.cardId === '12' ? { ...r, pictureUrl: `${r.pictureUrl}?v=2` } : r));
    const spy = spyOn(listingManager, 'rematchMismatches');
    try {
      await run(20, { force: true });
      expect(spy).toHaveBeenCalledWith('lego-minecraft-3', ids('12'));
    } finally {
      spy.mockRestore();
    }
  });

  test('a failing re-match after a sync is logged; the sync stands', async () => {
    const spy = spyOn(listingManager, 'rematchMismatches').mockImplementation(() => {
      throw new Error('db locked');
    });
    try {
      expect((await run(10))[0]).toMatchObject({ ok: true });
      expect(catalogManager.syncSucceededAt('lego-minecraft-3')).toBe(10);
      // The re-pictured cards are known only now: the admin is told which to re-check.
      const alert = alerts.find((a) => a.key.startsWith('catalog-rematch:lego-minecraft-3:'));
      expect(alert?.text).toContain('could not compare the mismatches of 251 card(s) again');
    } finally {
      spy.mockRestore();
    }
  });

  test("a collection's laststicker options reach the page read", async () => {
    const seen: unknown[] = [];
    await run(10, {
      collections: [legoMinecraft2],
      fetchSet: async (set, options) => {
        seen.push([set, options]);
        return { setId: 12126, rows: [] };
      },
    });
    expect(seen).toEqual([
      [
        'blue_ocean_lego_minecraft_tnt_boom_bastic',
        { scans: false, numberAliases: { XXL: 'XXL1' } },
      ],
    ]);
  });

  test("the collection's card id rule reads the page: Turbo Attax stores its codes", async () => {
    const rules: unknown[] = [];
    const outcomes = await run(10, {
      collections: [turboAttax2026],
      fetchSet: async (set, options, _fetchFn, rule) => {
        rules.push(rule);
        return fetchLaststickerSet(
          set,
          options,
          async () => new Response(readFixture('laststicker-turbo-attax-2026.html')),
          rule
        );
      },
    });
    expect(rules).toEqual([TURBO_ATTAX_CARD_IDS]);
    expect(outcomes.map((o) => o.ok)).toEqual([true]);
    const known = catalogManager.knownIds('turbo-attax-2026');
    expect(known.size).toBe(422);
    expect(known.has(cid('MR-HAM'))).toBe(true);
  });

  test('a collection never synced is due; a day later (less the slack) again, not before', async () => {
    expect(await run(10)).toMatchObject([
      {
        collection: 'lego-minecraft-3',
        ok: true,
        result: { added: [], renamed: [], vanished: [], nowListed: [] },
      },
    ]);
    expect(fetched).toEqual(['blue_ocean_lego_minecraft_on_fire']);
    expect(catalogManager.getCard('lego-minecraft-3', cid('12'))?.name).toBe('Card 12');
    expect(await run(10 + DAY - SYNC_SLACK_MS - 1)).toEqual([]);
    const next = 10 + DAY - SYNC_SLACK_MS;
    expect(await run(next)).toHaveLength(1);
    expect(fetched).toHaveLength(2);
    expect(db.select().from(catalogSyncs).all()).toEqual([
      { collection: 'lego-minecraft-3', attemptedAt: next, succeededAt: next },
    ]);
  });

  test('force syncs a collection that is not due', async () => {
    await run(10);
    expect(await run(20, { force: true, only: 'lego-minecraft-3' })).toHaveLength(1);
  });

  test.each([
    ['an HTTP error', new HttpError(503, 'https://www.laststicker.com/de/cards/x/')],
    ['an unreadable page', new CatalogLayoutError('laststicker: no checklist table')],
  ])('%s changes nothing, alerts once and resolves', async (_, error) => {
    const outcomes = await run(10, {
      fetchSet: async () => {
        throw error;
      },
    });
    expect(outcomes).toEqual([
      {
        collection: 'lego-minecraft-3',
        ok: false,
        kind: error instanceof CatalogLayoutError ? 'layout' : 'fetch',
        error: error.message,
      },
    ]);
    expect(catalogManager.getCard('lego-minecraft-3', cid('12'))?.name).toBeNull();
    expect(db.select().from(catalogSyncs).all()).toEqual([
      { collection: 'lego-minecraft-3', attemptedAt: 10, succeededAt: null },
    ]);
    expect(alerts).toEqual([
      {
        key: 'catalog-sync:lego-minecraft-3',
        text: `Catalog sync of LEGO Minecraft Serie 3 "On Fire" failed, nothing changed (never synced before): ${error.message}`,
      },
    ]);
    // Retried a day later, not on the next hourly run.
    expect(await run(10 + DAY - SYNC_SLACK_MS - 1)).toEqual([]);
  });

  test('a failure names the last success', async () => {
    await run(10);
    await run(10 + DAY, {
      fetchSet: async () => {
        throw new HttpError(503, 'https://x/');
      },
    });
    expect(alerts.at(-1)!.text).toContain('(last success <t:0:R>)');
  });

  test('/admin catalog sync (force) applies a page leaving out more, naming the cards', async () => {
    rows = starter.slice(0, 240).map((id) => row(id));
    const [failed] = await run(10);
    expect(failed).toMatchObject({ ok: false, kind: 'layout' });
    expect(failed!.ok === false && failed!.error).toContain(
      'missing from laststicker, more than 6:'
    );
    expect(failed!.ok === false && failed!.error).toContain('LE13, LE14');
    const [forced] = await run(20, { force: true });
    expect(forced).toMatchObject({ ok: true, result: { vanished: starter.slice(240) } });
  });

  test('a network error is a fetch failure', async () => {
    const [o] = await run(10, {
      fetchSet: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(o).toMatchObject({ ok: false, kind: 'fetch', error: 'fetch failed' });
  });

  test('a forced sync counts its reply as telling the admin', async () => {
    catalogManager.addManual('lego-minecraft-3', cid('229'), 'Mine', null, 1);
    rows = [...starter.map((id) => row(id)), row('229')];
    outcome = 'failed';
    await run(10, { force: true });
    expect(catalogManager.releaseManual('lego-minecraft-3', cid('229'), 11)).toEqual({ ok: true });
  });

  test('a page leaving out more than max(5, 2 %) of the stored cards changes nothing', async () => {
    rows = starter.slice(0, 240).map((id) => row(id));
    const [failed] = await run(10);
    expect(failed).toMatchObject({ ok: false, kind: 'layout' });
    expect(catalogManager.getCard('lego-minecraft-3', cid('1'))?.name).toBeNull();
    rows = starter.slice(0, 245).map((id) => row(id));
    const [synced] = await run(10 + DAY);
    expect(synced).toMatchObject({ ok: true, result: { vanished: starter.slice(245) } });
  });

  test("a due check that fails is that collection's failure, not a rejection", async () => {
    const spy = spyOn(catalogManager, 'syncAttemptedAt').mockImplementation(() => {
      throw new Error('database is locked');
    });
    try {
      expect(await run(10)).toEqual([
        { collection: 'lego-minecraft-3', ok: false, kind: 'other', error: 'database is locked' },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test('a bookkeeping failure after the sync applied still reports the sync', async () => {
    const spy = spyOn(catalogManager, 'markSyncSuccess').mockImplementation(() => {
      throw new Error('database is locked');
    });
    try {
      const [o] = await run(10);
      expect(o).toMatchObject({ ok: true });
      expect(catalogManager.getCard('lego-minecraft-3', cid('12'))?.name).toBe('Card 12');
      expect(alerts).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test('a now-listed note whose DM fails is sent again by the next sync', async () => {
    catalogManager.addManual('lego-minecraft-3', cid('229'), 'Mine', null, 1);
    rows = [...starter.map((id) => row(id)), row('229')];
    outcome = 'failed';
    await run(10);
    outcome = 'sent';
    await run(20, { force: true });
    await run(30, { force: true });
    expect(alerts.map((a) => a.key)).toEqual([
      'catalog-listed:lego-minecraft-3:229',
      'catalog-listed:lego-minecraft-3:229',
    ]);
  });

  test('a now-listed note held back by the throttle counts as noted', async () => {
    catalogManager.addManual('lego-minecraft-3', cid('229'), 'Mine', null, 1);
    rows = [...starter.map((id) => row(id)), row('229')];
    outcome = 'throttled';
    await run(10);
    outcome = 'sent';
    await run(20, { force: true });
    expect(alerts.map((a) => a.key)).toEqual(['catalog-listed:lego-minecraft-3:229']);
  });

  test('a failing note of the now-listed cards is logged and tried again', async () => {
    catalogManager.addManual('lego-minecraft-3', cid('229'), 'Mine', null, 1);
    rows = [...starter.map((id) => row(id)), row('229')];
    const spy = spyOn(catalogManager, 'markListedNoted').mockImplementation(() => {
      throw new Error('database is locked');
    });
    try {
      const [o] = await run(10);
      expect(o).toMatchObject({ ok: true });
    } finally {
      spy.mockRestore();
    }
    expect((await run(20, { force: true }))[0]).toMatchObject({
      ok: true,
      result: { nowListed: ids('229') },
    });
  });

  test('a timeout is a fetch failure', async () => {
    const [o] = await run(10, {
      fetchSet: async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    });
    expect(o).toMatchObject({ ok: false, kind: 'fetch' });
  });

  test('a last success that cannot be read leaves the failure alert intact', async () => {
    const spy = spyOn(catalogManager, 'syncSucceededAt').mockImplementation(() => {
      throw new Error('database is locked');
    });
    try {
      await run(10, {
        fetchSet: async () => {
          throw new HttpError(503, 'https://x/');
        },
      });
    } finally {
      spy.mockRestore();
    }
    expect(alerts.at(-1)!.text).toContain('(last success unknown)');
  });

  test('vanished and newly listed manual cards are reported', async () => {
    catalogManager.addManual('lego-minecraft-3', cid('229'), 'Mine', null, 1);
    rows = [...starter.filter((id) => id !== '12').map((id) => row(id)), row('229')];
    await run(10);
    expect(alerts).toEqual([
      {
        key: 'catalog-vanished:lego-minecraft-3',
        text: 'LEGO Minecraft Serie 3 "On Fire": 1 card(s) no longer on laststicker, kept: #12',
      },
      {
        key: 'catalog-listed:lego-minecraft-3:229',
        text: 'LEGO Minecraft Serie 3 "On Fire": manual card(s) now on laststicker: #229 — /admin catalog release hands one over',
      },
    ]);
  });

  test('only syncs just that collection', async () => {
    const other: CollectionDefinition = {
      id: 'other-set' as CollectionId,
      name: 'Other',
      cardIds: MINECRAFT_CARD_IDS,
      kleinanzeigen: 'x',
      shops: {},
      laststicker: { set: 'other_set' },
    };
    await run(10, { collections: [legoMinecraft3, other], only: 'lego-minecraft-3', force: true });
    expect(fetched).toEqual(['blue_ocean_lego_minecraft_on_fire']);
    expect(sleeps).toEqual([]);
  });

  test('two syncs at once run one after the other, 1500 ms apart', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const slow = async (set: string) => {
      order.push(`start ${set}`);
      if (order.length === 1) await held;
      order.push(`end ${set}`);
      return { setId: 12125, rows };
    };
    const first = run(10, { fetchSet: slow, force: true });
    const second = run(10, { fetchSet: slow, force: true });
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([
      'start blue_ocean_lego_minecraft_on_fire',
      'end blue_ocean_lego_minecraft_on_fire',
      'start blue_ocean_lego_minecraft_on_fire',
      'end blue_ocean_lego_minecraft_on_fire',
    ]);
    expect(sleeps).toEqual([1500]);
  });

  test('a second collection on laststicker waits 1500 ms', async () => {
    const other: CollectionDefinition = {
      id: 'other-set' as CollectionId,
      name: 'Other',
      cardIds: MINECRAFT_CARD_IDS,
      kleinanzeigen: 'x',
      shops: {},
      laststicker: { set: 'other_set' },
    };
    const outcomes = await run(10, { collections: [legoMinecraft3, other] });
    expect(fetched).toEqual(['blue_ocean_lego_minecraft_on_fire', 'other_set']);
    expect(sleeps).toEqual([1500]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
    expect(catalogManager.knownIds('other-set' as CollectionId)).toEqual(new Set(starter));
  });

  test('a collection without a laststicker set is skipped', async () => {
    const plain: CollectionDefinition = {
      id: 'other-set' as CollectionId,
      name: 'Other',
      cardIds: MINECRAFT_CARD_IDS,
      kleinanzeigen: 'x',
      shops: {},
    };
    expect(await run(10, { collections: [plain] })).toEqual([]);
    expect(fetched).toEqual([]);
  });
});

describe('createSyncGate', () => {
  test('waits only what is left of 1500 ms, and nothing for an earlier clock', async () => {
    const gate = createSyncGate();
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    await gate.beforeRequest(() => 1000, sleep);
    await gate.beforeRequest(() => 2000, sleep);
    await gate.beforeRequest(() => 5000, sleep);
    await gate.beforeRequest(() => 10, sleep);
    expect(sleeps).toEqual([500]);
  });
});

describe('formatSyncOutcome', () => {
  test('names at most 20 ids, then how many more', () => {
    const many = Array.from({ length: 25 }, (_, i) => cid(String(i + 1)));
    const text = formatSyncOutcome({
      collection: 'lego-minecraft-3',
      ok: true,
      result: { added: [], renamed: [], vanished: many, nowListed: [], repictured: [] },
    });
    expect(text).toContain('25 vanished (#1, #2,');
    expect(text).toContain('#20 … and 5 more)');
  });

  test('names the collection and the counts, or the error', () => {
    expect(
      formatSyncOutcome({
        collection: 'lego-minecraft-3',
        ok: true,
        result: {
          added: ids('LE23'),
          renamed: ids('1', '2'),
          vanished: ids('12'),
          nowListed: [],
          repictured: [],
        },
      })
    ).toBe(
      'LEGO Minecraft Serie 3 "On Fire": 1 added, 2 renamed, 1 vanished (#12), 0 manual now listed'
    );
    expect(
      formatSyncOutcome({
        collection: 'lego-minecraft-3',
        ok: false,
        kind: 'fetch',
        error: 'HTTP 503',
      })
    ).toBe('LEGO Minecraft Serie 3 "On Fire": sync failed, nothing changed: HTTP 503');
  });
});
