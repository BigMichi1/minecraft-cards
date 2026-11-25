import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
import type { CollectionId } from '../collections/ids';
import { db, initializeDatabase } from './db';
import { adminAlerts, runs } from './schema/index';
import {
  LAST_SUCCESS_WINDOW_MS,
  resetWarnings,
  runManager,
  setShopEntry,
  shopEntries,
  shopEntry,
} from './runManager';
import type { RunSummary } from '../check/runner';

const NOW = 10_000_000_000;

const summary: RunSummary = {
  startedAt: NOW,
  finishedAt: NOW + 1,
  shops: { 'blue-ocean': { listings: 3 } },
  notified: 1,
  dmFailures: 0,
};

describe('runManager', () => {
  beforeAll(() => {
    initializeDatabase();
  });
  beforeEach(() => {
    db.delete(runs).run();
    db.delete(adminAlerts).run();
    resetWarnings();
  });

  test('lastSuccess is the start of the newest run in which the shop had no error', () => {
    runManager.record({
      ...summary,
      startedAt: 100,
      shops: { 'blue-ocean': { listings: 0, error: 'down' } },
    });
    runManager.record({ ...summary, startedAt: 200, shops: { 'blue-ocean': { listings: 5 } } });
    runManager.record({
      ...summary,
      startedAt: 300,
      shops: { 'blue-ocean': { listings: 0, error: 'down' } },
    });
    expect(runManager.lastSuccess('blue-ocean', 'lego-minecraft-3', 300)).toBe(200);
  });

  test('lastSuccess of a shop that never appeared is undefined', () => {
    runManager.record(summary);
    expect(runManager.lastSuccess('ebay', 'lego-minecraft-3', NOW)).toBeUndefined();
  });

  test('lastSuccess stops at the newest successful run and does not read older rows', () => {
    for (let i = 0; i < 120; i++)
      db.insert(runs).values({ startedAt: i, finishedAt: i, summary: 'not json' }).run();
    runManager.record({ ...summary, startedAt: 500 });
    const warn = spyOn(logger, 'warn');
    try {
      expect(runManager.lastSuccess('blue-ocean', 'lego-minecraft-3', 500)).toBe(500);
      expect(warn).not.toHaveBeenCalled(); // the 120 unreadable older rows were never parsed
    } finally {
      warn.mockRestore();
    }
  });

  test('lastSuccess pages past 50 rows: unreadable rows and 60 newer failures', () => {
    runManager.record({ ...summary, startedAt: 1 });
    for (let i = 0; i < 50; i++)
      db.insert(runs).values({ startedAt: 2, finishedAt: 2, summary: 'not json' }).run();
    for (let i = 0; i < 60; i++) {
      runManager.record({
        ...summary,
        startedAt: 3 + i,
        shops: { 'blue-ocean': { listings: 0, error: 'down' } },
      });
    }
    const warn = spyOn(logger, 'warn');
    try {
      expect(runManager.lastSuccess('blue-ocean', 'lego-minecraft-3', 100)).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('lastSuccess only looks at runs that started within the last 7 days', () => {
    runManager.record({ ...summary, startedAt: NOW });
    expect(
      runManager.lastSuccess('blue-ocean', 'lego-minecraft-3', NOW + LAST_SUCCESS_WINDOW_MS)
    ).toBe(NOW);
    expect(
      runManager.lastSuccess('blue-ocean', 'lego-minecraft-3', NOW + LAST_SUCCESS_WINDOW_MS + 1)
    ).toBeUndefined();
    expect(LAST_SUCCESS_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test('latestReadable is the newest readable run and says whether a newer row was unreadable', () => {
    expect(runManager.latestReadable()).toEqual({ summary: undefined, newerUnreadable: false });
    runManager.record(summary);
    expect(runManager.latestReadable()).toEqual({ summary, newerUnreadable: false });
    const warn = spyOn(logger, 'warn');
    try {
      db.insert(runs).values({ startedAt: 1, finishedAt: 2, summary: 'not json' }).run();
      expect(runManager.latestReadable()).toEqual({ summary, newerUnreadable: true });
    } finally {
      warn.mockRestore();
    }
  });

  test('latestReadable with only unreadable rows has no summary but flags them', () => {
    const warn = spyOn(logger, 'warn');
    try {
      for (let i = 0; i < 60; i++)
        db.insert(runs).values({ startedAt: 1, finishedAt: 2, summary: '{}' }).run();
      expect(runManager.latestReadable()).toEqual({ summary: undefined, newerUnreadable: true });
    } finally {
      warn.mockRestore();
    }
  });

  test('last returns the most recent recorded summary', () => {
    expect(runManager.last()).toBeUndefined();
    runManager.record(summary);
    runManager.record({ ...summary, notified: 7 });
    expect(runManager.last()?.notified).toBe(7);
    expect(runManager.last()?.shops['blue-ocean']?.listings).toBe(3);
  });

  test('a stored summary that is not a run summary reads as no run, with a warning', () => {
    const warn = spyOn(logger, 'warn');
    try {
      db.insert(runs).values({ startedAt: 1, finishedAt: 2, summary: '{"shops":3}' }).run();
      expect(runManager.last()).toBeUndefined();
      db.insert(runs).values({ startedAt: 1, finishedAt: 2, summary: 'not json' }).run();
      expect(runManager.last()).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.some((c) => /unreadable: .*JSON/i.test(String(c[0])))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('a JSON null or number summary warns once, reads as no run and is skipped', () => {
    const warn = spyOn(logger, 'warn');
    try {
      db.insert(runs).values({ startedAt: NOW, finishedAt: NOW, summary: 'null' }).run();
      db.insert(runs).values({ startedAt: NOW, finishedAt: NOW, summary: '42' }).run();
      runManager.record(summary);
      expect(runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW)).toBe(3);
      expect(runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW)).toBe(3);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.every((c) => /not an object/.test(String(c[0])))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('shopPeakListings strict: an unreadable row in the window makes the peak unknown', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      runManager.record(summary);
      db.insert(runs).values({ startedAt: NOW, finishedAt: NOW, summary: '{broken' }).run();
      expect(runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW)).toBe(3);
      expect(
        runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW, { strict: true })
      ).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  test('shopPeakListings strict: an unreadable entry of the shop and collection makes the peak unknown', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => logger);
    const row = (extra: Record<string, unknown>) =>
      db
        .insert(runs)
        .values({
          startedAt: NOW,
          finishedAt: NOW,
          summary: JSON.stringify({
            startedAt: NOW,
            finishedAt: NOW,
            notified: 0,
            dmFailures: 0,
            shops: {},
            ...extra,
          }),
        })
        .run();
    const strict = (c: CollectionId) =>
      runManager.shopPeakListings('blue-ocean', c, NOW, { strict: true });
    try {
      runManager.record(summary);
      // Another shop's or collection's entry does not matter.
      row({ shops: { ebay: { listings: 'x' } }, collections: { 'lego-minecraft-2': {} } });
      expect(strict('lego-minecraft-3')).toBe(3);
      expect(strict('lego-minecraft-1')).toBeUndefined(); // no run at all
      row({ shops: { 'blue-ocean': { listings: 'x' } } });
      expect(strict('lego-minecraft-3')).toBeUndefined();
      expect(runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW)).toBe(3);
      row({ collections: { 'lego-minecraft-1': { 'blue-ocean': { listings: 2 } } } });
      expect(strict('lego-minecraft-1')).toBe(2);
      row({ collections: { 'lego-minecraft-1': { 'blue-ocean': null } } });
      expect(strict('lego-minecraft-1')).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  test('shopPeakListings strict: an unreadable collections map or collection makes the peak unknown', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => logger);
    const row = (collections: unknown) =>
      db
        .insert(runs)
        .values({
          startedAt: NOW,
          finishedAt: NOW,
          summary: JSON.stringify({
            startedAt: NOW,
            finishedAt: NOW,
            notified: 0,
            dmFailures: 0,
            shops: {},
            collections,
          }),
        })
        .run();
    const strict = () =>
      runManager.shopPeakListings('blue-ocean', 'lego-minecraft-1', NOW, { strict: true });
    try {
      row({ 'lego-minecraft-1': { 'blue-ocean': { listings: 2 } } });
      expect(strict()).toBe(2);
      // A readable collection without the shop's entry does not matter.
      row({ 'lego-minecraft-1': { 'sammel-ente': { listings: 1 } } });
      expect(strict()).toBe(2);
      row({ 'lego-minecraft-1': 'x' });
      expect(strict()).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
    db.delete(runs).run();
    const warn2 = spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      row({ 'lego-minecraft-1': { 'blue-ocean': { listings: 2 } } });
      row(5);
      expect(strict()).toBeUndefined();
    } finally {
      warn2.mockRestore();
    }
  });

  test('a summary of an older version without the newer optional fields still reads', () => {
    runManager.record(summary);
    expect(runManager.last()).toEqual(summary);
    expect(runManager.last()?.error).toBeUndefined();
  });

  test('shopPeakListings skips runs where the shop failed or did not run', () => {
    expect(runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW)).toBeUndefined();
    runManager.record(summary);
    runManager.record({ ...summary, shops: { 'blue-ocean': { listings: 0, error: 'down' } } });
    runManager.record({ ...summary, shops: {} });
    expect(runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW)).toBe(3);
    expect(runManager.shopPeakListings('ebay', 'lego-minecraft-3', NOW)).toBeUndefined();
  });

  test('shopPeakListings is the highest count within the last 3 days, however many runs', () => {
    const hour = 60 * 60 * 1000;
    // Hourly runs: 100 at hour 0, then 40 runs of 10.
    runManager.record({ ...summary, startedAt: NOW, shops: { 'blue-ocean': { listings: 100 } } });
    for (let h = 1; h <= 40; h += 1) {
      runManager.record({
        ...summary,
        startedAt: NOW + h * hour,
        shops: { 'blue-ocean': { listings: 10 } },
      });
    }
    expect(runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW + 40 * hour)).toBe(
      100
    );
    // 72 h after the 100 it leaves the window.
    expect(runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW + 72 * hour)).toBe(
      100
    );
    expect(runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW + 72 * hour + 1)).toBe(
      10
    );
  });

  test('shopPeakListings still sees the peak when more than 500 runs happened in the window', () => {
    // One-minute interval: 600 runs in 10 hours, the peak first.
    const minute = 60 * 1000;
    runManager.record({ ...summary, startedAt: NOW, shops: { 'blue-ocean': { listings: 100 } } });
    for (let m = 1; m <= 600; m += 1) {
      runManager.record({
        ...summary,
        startedAt: NOW + m * minute,
        shops: { 'blue-ocean': { listings: 10 } },
      });
    }
    expect(runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW + 600 * minute)).toBe(
      100
    );
  });

  test('shopPeakListings ignores a corrupted shop entry and warns about an unreadable row', () => {
    const warn = spyOn(logger, 'warn');
    try {
      runManager.record(summary);
      db.insert(runs)
        .values({
          startedAt: NOW,
          finishedAt: NOW,
          summary: JSON.stringify({ ...summary, shops: { 'blue-ocean': { listings: 'many' } } }),
        })
        .run();
      db.insert(runs).values({ startedAt: NOW, finishedAt: NOW, summary: 'not json' }).run();
      expect(runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW)).toBe(3);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('a null, string or listing-less shop entry is dropped with a warning, not thrown on', () => {
    const warn = spyOn(logger, 'warn');
    try {
      runManager.record(summary);
      const bad = { 'blue-ocean': null, ebay: 'down', 'sammel-ente': { error: 'x' } };
      db.insert(runs)
        .values({
          startedAt: NOW,
          finishedAt: NOW,
          summary: JSON.stringify({ ...summary, shops: bad }),
        })
        .run();
      expect(runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW)).toBe(3);
      expect(runManager.shopPeakListings('ebay', 'lego-minecraft-3', NOW)).toBeUndefined();
      expect(runManager.last()?.shops).toEqual({});
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  test('an unreadable row warns once per row, not on every read', () => {
    const warn = spyOn(logger, 'warn');
    try {
      db.insert(runs).values({ startedAt: NOW, finishedAt: NOW, summary: 'not json' }).run();
      runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW);
      runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', NOW);
      runManager.last();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('shopEntry reads series 3 from shops and the other collections from collections', () => {
    const s: RunSummary = {
      ...summary,
      shops: { 'sammel-ente': { listings: 251 } },
      collections: { 'lego-minecraft-1': { 'sammel-ente': { listings: 283 } } },
    };
    expect(shopEntry(s, 'lego-minecraft-3', 'sammel-ente')).toEqual({ listings: 251 });
    expect(shopEntry(s, 'lego-minecraft-1', 'sammel-ente')).toEqual({ listings: 283 });
    expect(shopEntry(s, 'lego-minecraft-2', 'sammel-ente')).toBeUndefined();
    // A row from before collections: only series 3, under shops.
    expect(shopEntry({ ...summary }, 'lego-minecraft-1', 'blue-ocean')).toBeUndefined();
    expect(shopEntry({ ...summary }, 'lego-minecraft-3', 'blue-ocean')).toEqual({ listings: 3 });
  });

  test('setShopEntry files each collection where shopEntry reads it; shopEntries lists them', () => {
    const s: RunSummary = { ...summary, shops: {} };
    setShopEntry(s, 'lego-minecraft-3', 'collect-it', { listings: 1 });
    setShopEntry(s, 'lego-minecraft-1', 'collect-it', { listings: 2 });
    expect(s.shops).toEqual({ 'collect-it': { listings: 1 } });
    expect(s.collections).toEqual({ 'lego-minecraft-1': { 'collect-it': { listings: 2 } } });
    expect(shopEntries(s)).toEqual([
      { collection: 'lego-minecraft-1', shop: 'collect-it', entry: { listings: 2 } },
      { collection: 'lego-minecraft-3', shop: 'collect-it', entry: { listings: 1 } },
    ]);
  });

  test('the peak and the last success are per shop and collection', () => {
    runManager.record({
      ...summary,
      shops: { 'sammel-ente': { listings: 251 } },
      collections: { 'lego-minecraft-1': { 'sammel-ente': { listings: 283 } } },
    });
    expect(runManager.shopPeakListings('sammel-ente', 'lego-minecraft-1', NOW)).toBe(283);
    expect(runManager.shopPeakListings('sammel-ente', 'lego-minecraft-3', NOW)).toBe(251);
    expect(runManager.shopPeakListings('sammel-ente', 'lego-minecraft-2', NOW)).toBeUndefined();
    expect(runManager.lastSuccess('sammel-ente', 'lego-minecraft-1', NOW)).toBe(NOW);
    expect(runManager.lastSuccess('sammel-ente', 'lego-minecraft-2', NOW)).toBeUndefined();
  });

  test('a stored collections map with a malformed entry drops just that entry', () => {
    db.insert(runs)
      .values({
        startedAt: NOW,
        finishedAt: NOW,
        summary: JSON.stringify({
          ...summary,
          collections: {
            'lego-minecraft-1': { 'sammel-ente': { listings: 'x' }, 'collect-it': { listings: 4 } },
          },
        }),
      })
      .run();
    const read = runManager.last()!;
    expect(read.collections).toEqual({ 'lego-minecraft-1': { 'collect-it': { listings: 4 } } });
  });

  test('a stored collections value that is not an object is dropped, warned once per row', () => {
    const warn = spyOn(logger, 'warn');
    try {
      for (const bad of [5, null, ['x']]) {
        db.delete(runs).run();
        db.insert(runs)
          .values({
            startedAt: NOW,
            finishedAt: NOW,
            summary: JSON.stringify({ ...summary, collections: bad }),
          })
          .run();
        const read = runManager.last()!;
        expect(read.collections).toBeUndefined();
        expect(read.shops).toEqual(summary.shops);
      }
      runManager.last();
      const warned = warn.mock.calls.filter((c) =>
        String(c[0]).includes('stored collections are not an object')
      );
      // One row per bad value, each warned once however often it is read.
      expect(warned).toHaveLength(3);
    } finally {
      warn.mockRestore();
    }
  });

  test('a stored collection with bad results, an unknown id or series 3 is dropped, warned', () => {
    const warn = spyOn(logger, 'warn');
    try {
      db.insert(runs)
        .values({
          startedAt: NOW,
          finishedAt: NOW,
          summary: JSON.stringify({
            ...summary,
            collections: {
              'lego-minecraft-1': 'x',
              'lego-minecraft-9': { 'sammel-ente': { listings: 1 } },
              'lego-minecraft-3': { 'sammel-ente': { listings: 1 } },
              'lego-minecraft-2': { 'sammel-ente': { listings: 2 }, 'shop-x': { listings: 3 } },
            },
          }),
        })
        .run();
      expect(runManager.last()!.collections).toEqual({
        'lego-minecraft-2': { 'sammel-ente': { listings: 2 } },
      });
      const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('stored lego-minecraft-1 results are not an object');
      expect(warned).toContain('stored collection lego-minecraft-9 is unknown');
      expect(warned).toContain('stored collection lego-minecraft-3 belongs in shops');
      expect(warned).toContain('stored lego-minecraft-2 shop-x is no shop');
    } finally {
      warn.mockRestore();
    }
  });

  test('pruneAlerts drops throttle rows older than the cutoff and keeps the rest (R7)', () => {
    runManager.shouldAlert('old', 1000, 500);
    runManager.shouldAlert('new', 5000, 500);
    expect(runManager.pruneAlerts(2000)).toBe(1);
    expect(runManager.lastAlertAt('old')).toBeUndefined();
    expect(runManager.lastAlertAt('new')).toBe(5000);
  });

  test('shouldAlert is true once per period', () => {
    expect(runManager.shouldAlert('k', 1000, 500)).toBe(true);
    expect(runManager.shouldAlert('k', 1200, 500)).toBe(false);
    expect(runManager.shouldAlert('other', 1200, 500)).toBe(true);
    expect(runManager.shouldAlert('k', 1500, 500)).toBe(true);
    expect(runManager.shouldAlert('k', 1600, 500)).toBe(false);
  });

  test('releaseAlert restores the previous state', () => {
    expect(runManager.lastAlertAt('k')).toBeUndefined();
    runManager.shouldAlert('k', 1000, 500);
    runManager.releaseAlert('k', undefined);
    expect(runManager.shouldAlert('k', 1100, 500)).toBe(true);
    runManager.shouldAlert('k', 2000, 500);
    runManager.releaseAlert('k', 1100);
    expect(runManager.lastAlertAt('k')).toBe(1100);
  });
});
