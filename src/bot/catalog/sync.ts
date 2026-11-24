import type { CardId } from '../cards/cardId';
import type { AlertFn } from '../check/adminAlert';
import type { CollectionDefinition, CollectionId } from '../collections/ids';
import { COLLECTIONS, collectionName } from '../collections/index';
import { catalogManager, type SyncResult } from '../database/catalogManager';
import { errorMessage, sleep as realSleep } from '../utils/async';
import { logError } from '../utils/logger';
import { DISCORD_MESSAGE_LIMIT, clipText } from '../utils/messageLimit';
import { fetchLaststickerSet } from './laststicker';

/** A collection's catalog is synced at most once per this, failed or not. */
export const SYNC_EVERY_MS = 24 * 60 * 60 * 1000;

/** Between two requests to laststicker. */
const REQUEST_DELAY_MS = 1500;

/** At most this many card ids are named in an alert or reply. */
const MAX_NAMED = 20;

export type SyncOutcome = { collection: CollectionId } & (
  { ok: true; result: SyncResult } | { ok: false; error: string }
);

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
  const ids = (list: CardId[]) => (list.length > 0 ? ` (${named(list)})` : '');
  return clipText(
    `${name}: ${added.length} added, ${renamed.length} renamed, ${vanished.length} vanished${ids(vanished)}, ${nowListed.length} manual now listed${ids(nowListed)}`
  );
}

async function syncOne(
  definition: CollectionDefinition & { laststicker: { set: string } },
  deps: SyncDeps
): Promise<SyncOutcome> {
  const collection = definition.id;
  const name = collectionName(collection);
  try {
    catalogManager.markSyncAttempt(collection, deps.now());
    const { rows } = await (deps.fetchSet ?? fetchLaststickerSet)(definition.laststicker.set);
    const result = catalogManager.syncCollection(collection, rows, deps.now());
    catalogManager.markSyncSuccess(collection, deps.now());
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
      await deps.alert(
        `catalog-listed:${collection}:${result.nowListed.join(',')}`,
        clipText(
          `${name}: manual card(s) now on laststicker: ${named(result.nowListed)} — /admin catalog release hands one over`,
          DISCORD_MESSAGE_LIMIT
        )
      );
    }
    return { collection, ok: true, result };
  } catch (error) {
    const message = errorMessage(error);
    logError(`catalog sync of ${collection} failed`, error);
    await deps.alert(
      `catalog-sync:${collection}`,
      clipText(`Catalog sync of ${name} failed, nothing changed: ${message}`, DISCORD_MESSAGE_LIMIT)
    );
    return { collection, ok: false, error: message };
  }
}

/**
 * Sync every collection with a laststicker set that is due (last attempt SYNC_EVERY_MS ago or
 * never), or every one with `force`; one page per collection, REQUEST_DELAY_MS apart. A failed
 * sync changes nothing and alerts (throttled per collection); vanished and newly listed manual
 * cards alert too. Never rejects.
 */
export async function syncCatalogs(deps: SyncDeps): Promise<SyncOutcome[]> {
  const sleep = deps.sleep ?? realSleep;
  const outcomes: SyncOutcome[] = [];
  for (const definition of deps.collections ?? COLLECTIONS) {
    const { laststicker } = definition;
    if (!laststicker) continue;
    if (deps.only !== undefined && definition.id !== deps.only) continue;
    const last = catalogManager.syncAttemptedAt(definition.id);
    if (!deps.force && last !== undefined && deps.now() - last < SYNC_EVERY_MS) continue;
    if (outcomes.length > 0) await sleep(REQUEST_DELAY_MS);
    outcomes.push(await syncOne({ ...definition, laststicker }, deps));
  }
  return outcomes;
}
