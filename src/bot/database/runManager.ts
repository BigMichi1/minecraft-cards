import { desc, eq, gte } from 'drizzle-orm';
import type { RunSummary, ShopSummary } from '../check/runner';
import type { ShopId } from '../shops/types';
import logger from '../utils/logger';
import { db } from './db';
import { adminAlerts, runs } from './schema/index';

/**
 * How far back `shopPeakListings` looks. Longer than the 24 h alert throttle, so a lasting drop
 * is still measured against the healthy counts when its next alert is due.
 */
const SHOP_PEAK_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Upper bound of rows read for the window (3 days at a 9 minute interval; shorter intervals see less). */
const SHOP_HISTORY_RUNS = 500;

/** Rows whose problems were already logged, so a bad row warns once per process, not per run. */
const warnedOnce = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  logger.warn(message);
}

/** A shop entry as written by every version: an object with a listing count, error optional. */
function isShopSummary(entry: unknown): entry is ShopSummary {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return typeof e.listings === 'number' && (e.error === undefined || typeof e.error === 'string');
}

/**
 * Parse a stored summary. Rows written by an older version lack newer fields, so every field
 * added to RunSummary after the first release must be optional; this check covers the fields
 * every version wrote. Shop entries that are not shop summaries are dropped with a warning.
 */
function parseSummary(json: string, rowId: number): RunSummary | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null) return undefined;
    const v = value as Record<string, unknown>;
    if (
      typeof v.startedAt !== 'number' ||
      typeof v.finishedAt !== 'number' ||
      typeof v.notified !== 'number' ||
      typeof v.dmFailures !== 'number' ||
      typeof v.shops !== 'object' ||
      v.shops === null
    ) {
      return undefined;
    }
    const shops: Record<string, ShopSummary> = {};
    for (const [shop, entry] of Object.entries(v.shops)) {
      if (isShopSummary(entry)) shops[shop] = entry;
      else warnOnce(`${rowId}:${shop}`, `run ${rowId}: stored ${shop} entry is not a shop summary`);
    }
    return { ...(value as RunSummary), shops };
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
    const summary = parseSummary(row.summary, row.id);
    if (!summary) warnOnce(`${row.id}`, `run ${row.id}: stored summary is not a run summary`);
    return summary;
  },

  /**
   * The highest number of listings `shop` returned in its successful runs that started within
   * the last 3 days before `now` (at most SHOP_HISTORY_RUNS rows); undefined when there is none.
   * Unreadable rows and entries are skipped with a warning, once per row.
   */
  shopPeakListings(shop: ShopId, now: number): number | undefined {
    const rows = db
      .select({ id: runs.id, summary: runs.summary })
      .from(runs)
      .where(gte(runs.startedAt, now - SHOP_PEAK_WINDOW_MS))
      .orderBy(desc(runs.id))
      .limit(SHOP_HISTORY_RUNS)
      .all();
    let peak: number | undefined;
    for (const row of rows) {
      const summary = parseSummary(row.summary, row.id);
      if (!summary) {
        warnOnce(`${row.id}`, `run ${row.id}: stored summary is not a run summary`);
        continue;
      }
      const entry = summary.shops[shop];
      if (entry === undefined || entry.error !== undefined) continue;
      peak = Math.max(peak ?? entry.listings, entry.listings);
    }
    return peak;
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
