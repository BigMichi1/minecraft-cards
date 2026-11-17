import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
import { db, initializeDatabase } from './db';
import { adminAlerts, runs } from './schema/index';
import { runManager } from './runManager';
import type { RunSummary } from '../check/runner';

const summary: RunSummary = {
  startedAt: 1,
  finishedAt: 2,
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
    expect(runManager.shopPeakListings('blue-ocean')).toBeUndefined();
    runManager.record(summary);
    runManager.record({ ...summary, shops: { 'blue-ocean': { listings: 0, error: 'down' } } });
    runManager.record({ ...summary, shops: {} });
    expect(runManager.shopPeakListings('blue-ocean')).toBe(3);
    expect(runManager.shopPeakListings('ebay')).toBeUndefined();
  });

  test('shopPeakListings is the highest count of the last 5 successful runs', () => {
    for (const listings of [90, 100, 10, 20, 30, 40]) {
      runManager.record({ ...summary, shops: { 'blue-ocean': { listings } } });
    }
    // 100 is the oldest of the last 5 successful runs (100, 10, 20, 30, 40) and still counts.
    expect(runManager.shopPeakListings('blue-ocean')).toBe(100);
    runManager.record({ ...summary, shops: { 'blue-ocean': { listings: 5 } } });
    // 90 and 100 have fallen out of the window.
    expect(runManager.shopPeakListings('blue-ocean')).toBe(40);
  });

  test('shopPeakListings ignores a corrupted shop entry and warns about an unreadable row', () => {
    const warn = spyOn(logger, 'warn');
    try {
      runManager.record(summary);
      db.insert(runs)
        .values({
          startedAt: 1,
          finishedAt: 2,
          summary: JSON.stringify({ ...summary, shops: { 'blue-ocean': { listings: 'many' } } }),
        })
        .run();
      db.insert(runs).values({ startedAt: 1, finishedAt: 2, summary: 'not json' }).run();
      expect(runManager.shopPeakListings('blue-ocean')).toBe(3);
      expect(warn).toHaveBeenCalledTimes(2);
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
