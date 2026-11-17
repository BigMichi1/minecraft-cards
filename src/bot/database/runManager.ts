import { desc, eq } from 'drizzle-orm';
import type { RunSummary } from '../check/runner';
import type { ShopId } from '../shops/types';
import logger from '../utils/logger';
import { db } from './db';
import { adminAlerts, runs } from './schema/index';

/** How many past runs `lastShopListings` looks through for one where the shop succeeded. */
const SHOP_HISTORY_RUNS = 50;

/**
 * Parse a stored summary. Rows written by an older version lack newer fields, so every field
 * added to RunSummary after the first release must be optional; this check covers the fields
 * every version wrote.
 */
function parseSummary(json: string): RunSummary | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null) return undefined;
    const v = value as Record<string, unknown>;
    const valid =
      typeof v.startedAt === 'number' &&
      typeof v.finishedAt === 'number' &&
      typeof v.notified === 'number' &&
      typeof v.dmFailures === 'number' &&
      typeof v.shops === 'object' &&
      v.shops !== null;
    return valid ? (value as RunSummary) : undefined;
  } catch {
    return undefined;
  }
}

export const runManager = {
  record(summary: RunSummary): void {
    db.insert(runs)
      .values({
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        summary: JSON.stringify(summary),
      })
      .run();
  },

  /** The latest run; undefined when none ran or its stored summary is unreadable (logged). */
  last(): RunSummary | undefined {
    const row = db.select().from(runs).orderBy(desc(runs.id)).limit(1).get();
    if (!row) return undefined;
    const summary = parseSummary(row.summary);
    if (!summary) logger.warn(`run ${row.id}: stored summary is not a run summary`);
    return summary;
  },

  /** Listings `shop` returned in the latest recent run where its fetch succeeded. */
  lastShopListings(shop: ShopId): number | undefined {
    const rows = db
      .select({ summary: runs.summary })
      .from(runs)
      .orderBy(desc(runs.id))
      .limit(SHOP_HISTORY_RUNS)
      .all();
    for (const row of rows) {
      const entry = parseSummary(row.summary)?.shops[shop];
      if (entry && entry.error === undefined) return entry.listings;
    }
    return undefined;
  },

  /** True (and remembers `now`) when no alert with this key went out within `everyMs`. */
  shouldAlert(key: string, now: number, everyMs: number): boolean {
    return db.transaction((tx) => {
      const row = tx.select().from(adminAlerts).where(eq(adminAlerts.key, key)).get();
      if (row && now - row.lastSentAt < everyMs) return false;
      tx.insert(adminAlerts)
        .values({ key, lastSentAt: now })
        .onConflictDoUpdate({ target: adminAlerts.key, set: { lastSentAt: now } })
        .run();
      return true;
    });
  },

  lastAlertAt(key: string): number | undefined {
    return db.select().from(adminAlerts).where(eq(adminAlerts.key, key)).get()?.lastSentAt;
  },

  /** Undo a `shouldAlert` whose alert could not be delivered: restore `previous` (undefined removes the key). */
  releaseAlert(key: string, previous: number | undefined): void {
    if (previous === undefined) db.delete(adminAlerts).where(eq(adminAlerts.key, key)).run();
    else db.update(adminAlerts).set({ lastSentAt: previous }).where(eq(adminAlerts.key, key)).run();
  },
};
