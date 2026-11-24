import type { CardId } from '../cards/cardId';
import type { AlertFn } from '../check/adminAlert';
import type { CollectionDefinition, CollectionId } from '../collections/ids';
import { COLLECTIONS, collectionName } from '../collections/index';
import { catalogManager, type SyncResult } from '../database/catalogManager';
import { listingManager } from '../database/listingManager';
import { errorMessage, sleep as realSleep } from '../utils/async';
import { logError } from '../utils/logger';
import { DISCORD_MESSAGE_LIMIT, clipText } from '../utils/messageLimit';
import { CatalogLayoutError, fetchLaststickerSet } from './laststicker';

/** A collection's catalog is synced about once per this, failed or not. */
export const SYNC_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * A sync is due this much before SYNC_EVERY_MS is up: the hourly runs start a little later
 * each time (interval jitter, `/admin run`), and without slack the daily slot would slip by an
 * hour at a time.
 */
export const SYNC_SLACK_MS = 30 * 60 * 1000;

/** Between two requests to laststicker, also across syncs. */
const REQUEST_DELAY_MS = 1500;

/** At most this many card ids are named in an alert or reply. */
const MAX_NAMED = 20;

/**
 * More stored laststicker cards missing from the page than max(5, ceil(2 %) of them) is taken
 * for a partial page and changes nothing, the rule of an eBay walk short of its total. A forced
 * sync (`/admin catalog sync`) has no limit: the admin who sees the missing cards named in the
 * failure alert accepts them by running it.
 */
function maxVanished(collection: CollectionId, force: boolean | undefined): number {
  if (force) return Number.POSITIVE_INFINITY;
  return Math.max(5, Math.ceil(catalogManager.laststickerCardCount(collection) * 0.02));
}

/** A fetch that failed (network, HTTP, timeout): tells it apart from a database error. */
class FetchFailed extends Error {
  constructor(readonly original: unknown) {
    super(errorMessage(original));
    this.name = 'FetchFailed';
  }
}

/** Why a sync failed: an unreadable page, an unreachable site, or anything else (database). */
export type SyncFailure = 'layout' | 'fetch' | 'other';

export type SyncOutcome = { collection: CollectionId } & (
  { ok: true; result: SyncResult } | { ok: false; kind: SyncFailure; error: string }
);

/** A collection with a laststicker set, the only kind syncCatalogs syncs. */
export type SyncableCollection = CollectionDefinition & {
  readonly laststicker: { readonly set: string };
};

/**
 * Runs syncs one at a time and keeps REQUEST_DELAY_MS between two laststicker requests, so
 * `/admin catalog sync` during a check run's sync neither overlaps it nor skips the pacing.
 */
export interface SyncGate {
  exclusive<T>(run: () => Promise<T>): Promise<T>;
  /** Wait until the next request may go out; `now` and `sleep` are the caller's. */
  beforeRequest(now: () => number, sleep: (ms: number) => Promise<void>): Promise<void>;
}

export function createSyncGate(): SyncGate {
  let queue: Promise<unknown> = Promise.resolve();
  let lastRequestAt: number | undefined;
  return {
    exclusive(run) {
      const next = queue.then(run);
      queue = next.catch(() => undefined);
      return next;
    },
    async beforeRequest(now, sleep) {
      if (lastRequestAt !== undefined) {
        const wait = lastRequestAt + REQUEST_DELAY_MS - now();
        // A clock earlier than the last request (a test's fake clock) waits nothing.
        if (wait > 0 && wait <= REQUEST_DELAY_MS) await sleep(wait);
      }
      lastRequestAt = now();
    },
  };
}

const defaultGate = createSyncGate();

export interface SyncDeps {
  now: () => number;
  alert: AlertFn;
  fetchSet?: typeof fetchLaststickerSet;
  sleep?: (ms: number) => Promise<void>;
  /** The collections to consider (default COLLECTIONS); only those with a laststicker set count. */
  collections?: readonly CollectionDefinition[];
  /** Only this collection. */
  only?: CollectionId;
  /** Sync even when not due (`/admin catalog sync`). */
  force?: boolean;
  /** Default: one gate for the process. */
  gate?: SyncGate;
}

function named(ids: readonly CardId[]): string {
  const shown = ids.slice(0, MAX_NAMED).join(', ');
  return ids.length > MAX_NAMED ? `${shown} … and ${ids.length - MAX_NAMED} more` : shown;
}

/** One line per outcome, as `/admin catalog sync` replies. */
export function formatSyncOutcome(o: SyncOutcome): string {
  const name = collectionName(o.collection);
  if (!o.ok) return clipText(`${name}: sync failed, nothing changed: ${o.error}`);
  const { added, renamed, vanished, nowListed } = o.result;
  const ids = (list: readonly CardId[]) => (list.length > 0 ? ` (${named(list)})` : '');
  return clipText(
    `${name}: ${added.length} added, ${renamed.length} renamed, ${vanished.length} vanished${ids(vanished)}, ${nowListed.length} manual now listed${ids(nowListed)}`
  );
}

function failureKind(error: unknown): SyncFailure {
  if (error instanceof CatalogLayoutError) return 'layout';
  return error instanceof FetchFailed ? 'fetch' : 'other';
}

/** `(last success <t:…:R>)` or `(never synced before)`, read without failing the alert. */
function lastSuccessNote(collection: CollectionId): string {
  try {
    const at = catalogManager.syncSucceededAt(collection);
    return at === undefined
      ? '(never synced before)'
      : `(last success <t:${Math.floor(at / 1000)}:R>)`;
  } catch {
    return '(last success unknown)';
  }
}

/** Fetch and apply one collection: the part that, failing, changes nothing. */
async function fetchAndApply(
  definition: SyncableCollection,
  deps: SyncDeps,
  sleep: (ms: number) => Promise<void>
): Promise<SyncResult | 'not_due'> {
  const collection = definition.id;
  const last = catalogManager.syncAttemptedAt(collection);
  if (!deps.force && last !== undefined && deps.now() - last < SYNC_EVERY_MS - SYNC_SLACK_MS) {
    return 'not_due';
  }
  catalogManager.markSyncAttempt(collection, deps.now());
  await (deps.gate ?? defaultGate).beforeRequest(deps.now, sleep);
  let rows;
  try {
    ({ rows } = await (deps.fetchSet ?? fetchLaststickerSet)(definition.laststicker.set));
  } catch (error) {
    // An unreadable page stays a layout error; anything else from the fetch is the network's.
    throw error instanceof CatalogLayoutError ? error : new FetchFailed(error);
  }
  return catalogManager.syncCollection(collection, rows, deps.now(), {
    maxVanished: maxVanished(collection, deps.force),
  });
}

/**
 * After an applied sync: record it, compare the mismatches of re-pictured cards again and tell
 * the admin; failures here are logged only.
 */
async function report(collection: CollectionId, result: SyncResult, deps: SyncDeps): Promise<void> {
  const name = collectionName(collection);
  try {
    catalogManager.markSyncSuccess(collection, deps.now());
  } catch (error) {
    logError(`catalog sync of ${collection} applied, but recording its success failed`, error);
  }
  try {
    // A new scan may settle a mismatch either way: compare those again.
    listingManager.rematchMismatches(collection, result.repictured);
  } catch (error) {
    logError(
      `catalog sync of ${collection} applied, but re-matching its new pictures failed`,
      error
    );
    // The changed cards are known only to this sync: name them, so the admin can act.
    await deps.alert(
      `catalog-rematch:${collection}`,
      clipText(
        `${name}: the sync could not compare the mismatches of ${result.repictured.length} card(s) again (new pictures): ${named(result.repictured)} — ${errorMessage(error)}`,
        DISCORD_MESSAGE_LIMIT
      )
    );
  }
  if (result.vanished.length > 0) {
    await deps.alert(
      `catalog-vanished:${collection}`,
      clipText(
        `${name}: ${result.vanished.length} card(s) no longer on laststicker, kept: ${named(result.vanished)}`,
        DISCORD_MESSAGE_LIMIT
      )
    );
  }
  if (result.nowListed.length > 0) {
    const outcome = await deps.alert(
      `catalog-listed:${collection}:${result.nowListed.join(',')}`,
      clipText(
        `${name}: manual card(s) now on laststicker: ${named(result.nowListed)} — /admin catalog release hands one over`,
        DISCORD_MESSAGE_LIMIT
      )
    );
    // Noted only once delivered (or held back as sent before): a failed DM is tried again. A
    // forced sync's outcome is the admin's own reply (`/admin catalog sync`), which names them.
    if (outcome !== 'failed' || deps.force) {
      try {
        catalogManager.markListedNoted(collection, result.nowListed, deps.now());
      } catch (error) {
        logError(`noting the now-listed cards of ${collection} failed`, error);
      }
    }
  }
}

async function syncOne(
  definition: SyncableCollection,
  deps: SyncDeps,
  sleep: (ms: number) => Promise<void>
): Promise<SyncOutcome | null> {
  const collection = definition.id;
  let result: SyncResult | 'not_due';
  try {
    result = await fetchAndApply(definition, deps, sleep);
  } catch (error) {
    const message = errorMessage(error);
    logError(
      `catalog sync of ${collection} failed`,
      error instanceof FetchFailed ? error.original : error
    );
    await deps.alert(
      `catalog-sync:${collection}`,
      clipText(
        `Catalog sync of ${collectionName(collection)} failed, nothing changed ${lastSuccessNote(collection)}: ${message}`,
        DISCORD_MESSAGE_LIMIT
      )
    );
    return { collection, ok: false, kind: failureKind(error), error: message };
  }
  if (result === 'not_due') return null;
  await report(collection, result, deps);
  return { collection, ok: true, result };
}

/**
 * Sync every collection with a laststicker set that is due (last attempt about SYNC_EVERY_MS
 * ago, or never), or every one with `force`; one page per collection, one sync at a time, at
 * least REQUEST_DELAY_MS between two requests. A failed fetch or an unreadable page changes
 * nothing and alerts (throttled per collection); vanished and newly listed manual cards alert
 * too. Each collection's failure is caught: never rejects for one.
 */
export async function syncCatalogs(deps: SyncDeps): Promise<SyncOutcome[]> {
  const sleep = deps.sleep ?? realSleep;
  return (deps.gate ?? defaultGate).exclusive(async () => {
    const outcomes: SyncOutcome[] = [];
    for (const definition of deps.collections ?? COLLECTIONS) {
      const { laststicker } = definition;
      if (!laststicker) continue;
      if (deps.only !== undefined && definition.id !== deps.only) continue;
      const outcome = await syncOne({ ...definition, laststicker }, deps, sleep);
      if (outcome) outcomes.push(outcome);
    }
    return outcomes;
  });
}
