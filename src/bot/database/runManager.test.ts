import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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
