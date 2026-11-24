import { desc, eq, gte, lt } from 'drizzle-orm';
import type { RunSummary, ShopSummary } from '../check/runner';
import { COLLECTION_IDS, LEGACY_COLLECTION, type CollectionId } from '../collections/ids';
import { SHOP_IDS, type ShopId } from '../shops/types';
import { errorMessage } from '../utils/async';
import logger from '../utils/logger';
import { db } from './db';
import { adminAlerts, runs } from './schema/index';

/**
 * How far back `shopPeakListings` looks. Longer than the 24 h alert throttle, so a lasting drop
 * is still measured against the healthy counts when its next alert is due.
 */
export const SHOP_PEAK_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * How far back `lastSuccess` looks. A success older than this is too old to vouch for stored
 * listings; `/missing status` says there was none in this window instead.
 */
export const LAST_SUCCESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Rows read per page by the newest-first scans; the runs table grows by one row per check. */
const PAGE = 50;

/** The newest run that can be read, and whether newer rows had to be skipped to reach it. */
export interface LatestRun {
  /** Undefined when no run was recorded or none of the rows can be read. */
  summary: RunSummary | undefined;
  /** True when at least one row newer than `summary` (or any row, without one) was unreadable. */
  newerUnreadable: boolean;
}

/** Rows whose problems were already logged, so a bad row warns once per process, not per run. */
const warnedOnce = new Set<string>();

/**
 * For tests: the set is module-level and outlives each test's data within one worker. Ids never
 * repeat (AUTOINCREMENT), so this is not about collisions: it keeps each test independent of
 * warnings that earlier tests caused.
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
 * A shop's result for a collection in a run. Series 3 (LEGACY_COLLECTION) lives in `shops`, as
 * in every row written before collections; every other collection in `collections`.
 */
export function shopEntry(
  summary: RunSummary,
  collection: CollectionId,
  shop: ShopId
): ShopSummary | undefined {
  return collection === LEGACY_COLLECTION
    ? summary.shops[shop]
    : summary.collections?.[collection]?.[shop];
}

/** Store a shop's result for a collection where shopEntry reads it. */
export function setShopEntry(
  summary: RunSummary,
  collection: CollectionId,
  shop: ShopId,
  entry: ShopSummary
): void {
  if (collection === LEGACY_COLLECTION) {
    summary.shops[shop] = entry;
    return;
  }
  summary.collections ??= {};
  (summary.collections[collection] ??= {})[shop] = entry;
}

/** Every shop result of a run, in COLLECTION_IDS then SHOP_IDS order. */
export function shopEntries(
  summary: RunSummary
): { collection: CollectionId; shop: ShopId; entry: ShopSummary }[] {
  return COLLECTION_IDS.flatMap((collection) =>
    SHOP_IDS.flatMap((shop) => {
      const entry = shopEntry(summary, collection, shop);
      return entry ? [{ collection, shop, entry }] : [];
    })
  );
}

/** A stored `collections` map with every entry that is no shop summary dropped (warned once). */
function parseCollections(value: unknown, rowId: number): RunSummary['collections'] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    warnOnce(`${rowId}:collections`, `run ${rowId}: stored collections are not an object`);
    return undefined;
  }
  const out: NonNullable<RunSummary['collections']> = {};
  for (const [collection, shops] of Object.entries(value)) {
    if (typeof shops !== 'object' || shops === null) continue;
    const kept: Partial<Record<ShopId, ShopSummary>> = {};
    for (const [shop, entry] of Object.entries(shops as Record<string, unknown>)) {
      if (isShopSummary(entry)) kept[shop as ShopId] = entry;
      else
        warnOnce(
          `${rowId}:${collection}:${shop}`,
          `run ${rowId}: stored ${collection} ${shop} entry is not a shop summary`
        );
    }
    out[collection as CollectionId] = kept;
  }
  return out;
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
  const collections = parseCollections(v.collections, rowId);
  return { ...(value as RunSummary), shops, ...(collections ? { collections } : {}) };
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
   * The highest number of listings `shop` returned for `collection` in its successful runs that started within
   * the last SHOP_PEAK_WINDOW_MS (3 days) before `now`, however many runs that is; undefined when
   * there is none.
   * Unreadable rows and entries are skipped with a warning, once per row.
   */
  shopPeakListings(shop: ShopId, collection: CollectionId, now: number): number | undefined {
    const rows = db
      .select({ id: runs.id, summary: runs.summary }) // id keys the once-per-row warning
      .from(runs)
      .where(gte(runs.startedAt, now - SHOP_PEAK_WINDOW_MS))
      .all();
    let peak: number | undefined;
    for (const row of rows) {
      const summary = parseSummary(row.summary, row.id);
      if (!summary) continue;
      const entry = shopEntry(summary, collection, shop);
      if (entry === undefined || entry.error !== undefined) continue;
      peak = Math.max(peak ?? entry.listings, entry.listings);
    }
    return peak;
  },

  /**
   * The newest readable run, scanning newest first a page at a time; unreadable rows are skipped
   * (warned once per row) and reported through `newerUnreadable`.
   */
  latestReadable(): LatestRun {
    let newerUnreadable = false;
    for (let offset = 0; ; offset += PAGE) {
      const rows = db
        .select({ id: runs.id, summary: runs.summary })
        .from(runs)
        .orderBy(desc(runs.id))
        .limit(PAGE)
        .offset(offset)
        .all();
      for (const row of rows) {
        const summary = parseSummary(row.summary, row.id);
        if (summary) return { summary, newerUnreadable };
        newerUnreadable = true;
      }
      if (rows.length < PAGE) return { summary: undefined, newerUnreadable };
    }
  },

  /**
   * When `shop` was last checked successfully for `collection`: the start of the newest run within the last
   * LAST_SUCCESS_WINDOW_MS (7 days) before `now` whose entry for it has no error. Undefined when
   * there is none in that window (or only in rows that can no longer be read).
   */
  lastSuccess(shop: ShopId, collection: CollectionId, now: number): number | undefined {
    // Newest first, a page at a time: the scan usually ends in the first page.
    for (let offset = 0; ; offset += PAGE) {
      const rows = db
        .select({ id: runs.id, summary: runs.summary })
        .from(runs)
        .where(gte(runs.startedAt, now - LAST_SUCCESS_WINDOW_MS))
        .orderBy(desc(runs.id))
        .limit(PAGE)
        .offset(offset)
        .all();
      for (const row of rows) {
        const summary = parseSummary(row.summary, row.id);
        const entry = summary ? shopEntry(summary, collection, shop) : undefined;
        if (summary && entry !== undefined && entry.error === undefined) return summary.startedAt;
      }
      if (rows.length < PAGE) return undefined;
    }
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

  /**
   * Drop the throttle rows last sent before `before`; returns how many. Keys such as
   * `mismatch:<listing>:<card>` would otherwise pile up forever.
   */
  pruneAlerts(before: number): number {
    return db.delete(adminAlerts).where(lt(adminAlerts.lastSentAt, before)).returning().all()
      .length;
  },

  /** Undo a `shouldAlert` whose alert could not be delivered: restore `previous` (undefined removes the key). */
  releaseAlert(key: string, previous: number | undefined): void {
    if (previous === undefined) db.delete(adminAlerts).where(eq(adminAlerts.key, key)).run();
    else db.update(adminAlerts).set({ lastSentAt: previous }).where(eq(adminAlerts.key, key)).run();
  },
};
