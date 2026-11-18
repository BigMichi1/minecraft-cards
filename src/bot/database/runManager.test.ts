import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
import { db, initializeDatabase } from './db';
import { adminAlerts, runs } from './schema/index';
import { LAST_SUCCESS_WINDOW_MS, resetWarnings, runManager } from './runManager';
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
    expect(runManager.lastSuccess('blue-ocean', 300)).toBe(200);
  });

  test('lastSuccess of a shop that never appeared is undefined', () => {
    runManager.record(summary);
    expect(runManager.lastSuccess('ebay', NOW)).toBeUndefined();
  });

  test('lastSuccess stops at the newest successful run and does not read older rows', () => {
    for (let i = 0; i < 120; i++)
      db.insert(runs).values({ startedAt: i, finishedAt: i, summary: 'not json' }).run();
    runManager.record({ ...summary, startedAt: 500 });
    const warn = spyOn(logger, 'warn');
    try {
      expect(runManager.lastSuccess('blue-ocean', 500)).toBe(500);
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
      expect(runManager.lastSuccess('blue-ocean', 100)).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('lastSuccess only looks at runs that started within the last 7 days', () => {
    runManager.record({ ...summary, startedAt: NOW });
    expect(runManager.lastSuccess('blue-ocean', NOW + LAST_SUCCESS_WINDOW_MS)).toBe(NOW);
    expect(runManager.lastSuccess('blue-ocean', NOW + LAST_SUCCESS_WINDOW_MS + 1)).toBeUndefined();
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
      expect(runManager.shopPeakListings('blue-ocean', NOW)).toBe(3);
      expect(runManager.shopPeakListings('blue-ocean', NOW)).toBe(3);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.every((c) => /not an object/.test(String(c[0])))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('a summary of an older version without the newer optional fields still reads', () => {
    runManager.record(summary);
    expect(runManager.last()).toEqual(summary);
    expect(runManager.last()?.error).toBeUndefined();
  });

  test('shopPeakListings skips runs where the shop failed or did not run', () => {
    expect(runManager.shopPeakListings('blue-ocean', NOW)).toBeUndefined();
    runManager.record(summary);
    runManager.record({ ...summary, shops: { 'blue-ocean': { listings: 0, error: 'down' } } });
    runManager.record({ ...summary, shops: {} });
    expect(runManager.shopPeakListings('blue-ocean', NOW)).toBe(3);
    expect(runManager.shopPeakListings('ebay', NOW)).toBeUndefined();
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
    expect(runManager.shopPeakListings('blue-ocean', NOW + 40 * hour)).toBe(100);
    // 72 h after the 100 it leaves the window.
    expect(runManager.shopPeakListings('blue-ocean', NOW + 72 * hour)).toBe(100);
    expect(runManager.shopPeakListings('blue-ocean', NOW + 72 * hour + 1)).toBe(10);
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
    expect(runManager.shopPeakListings('blue-ocean', NOW + 600 * minute)).toBe(100);
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
      expect(runManager.shopPeakListings('blue-ocean', NOW)).toBe(3);
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
      expect(runManager.shopPeakListings('blue-ocean', NOW)).toBe(3);
      expect(runManager.shopPeakListings('ebay', NOW)).toBeUndefined();
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
      runManager.shopPeakListings('blue-ocean', NOW);
      runManager.shopPeakListings('blue-ocean', NOW);
      runManager.last();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
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
