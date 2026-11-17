import { desc, eq, gte } from 'drizzle-orm';
import type { RunSummary, ShopSummary } from '../check/runner';
import type { ShopId } from '../shops/types';
import { errorMessage } from '../utils/async';
import logger from '../utils/logger';
import { db } from './db';
import { adminAlerts, runs } from './schema/index';

/**
 * How far back `shopPeakListings` looks. Longer than the 24 h alert throttle, so a lasting drop
 * is still measured against the healthy counts when its next alert is due.
 */
export const SHOP_PEAK_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Rows whose problems were already logged, so a bad row warns once per process, not per run. */
const warnedOnce = new Set<string>();

/**
 * Forget which rows were warned about (tests: the set outlives each test's data within one worker,
 * and row ids do not restart after a table is emptied, AUTOINCREMENT, so a later test would
 * otherwise inherit earlier warnings).
 */
export function resetWarnings(): void {
  warnedOnce.clear();
}

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
 * every version wrote. A row that is not valid JSON, not an object or lacks one of those fields
 * gives undefined; shop entries that are not shop summaries are dropped. Each problem is warned
 * once per process, with its reason.
 */
function parseSummary(json: string, rowId: number): RunSummary | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    warnOnce(`${rowId}`, `run ${rowId}: stored summary is unreadable: ${errorMessage(err)}`);
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    warnOnce(`${rowId}`, `run ${rowId}: stored summary is not an object`);
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.startedAt !== 'number' ||
    typeof v.finishedAt !== 'number' ||
    typeof v.notified !== 'number' ||
    typeof v.dmFailures !== 'number' ||
    typeof v.shops !== 'object' ||
    v.shops === null
  ) {
    warnOnce(`${rowId}`, `run ${rowId}: stored summary lacks a field every version wrote`);
    return undefined;
  }
  const shops: Record<string, ShopSummary> = {};
  for (const [shop, entry] of Object.entries(v.shops)) {
    if (isShopSummary(entry)) shops[shop] = entry;
    else warnOnce(`${rowId}:${shop}`, `run ${rowId}: stored ${shop} entry is not a shop summary`);
  }
  return { ...(value as RunSummary), shops };
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
    return parseSummary(row.summary, row.id);
  },

  /**
   * The highest number of listings `shop` returned in its successful runs that started within
   * the last SHOP_PEAK_WINDOW_MS (3 days) before `now`, however many runs that is; undefined when
   * there is none.
   * Unreadable rows and entries are skipped with a warning, once per row.
   */
  shopPeakListings(shop: ShopId, now: number): number | undefined {
    const rows = db
      .select({ id: runs.id, summary: runs.summary }) // id keys the once-per-row warning
      .from(runs)
      .where(gte(runs.startedAt, now - SHOP_PEAK_WINDOW_MS))
      .all();
    let peak: number | undefined;
    for (const row of rows) {
      const summary = parseSummary(row.summary, row.id);
      if (!summary) continue;
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
