import type { CardId } from '../cards/cardId';
import type { CollectionDefinition, CollectionId } from '../collections/ids';
import { collectionById, collectionName } from '../collections/index';
import { catalogManager, type ReferenceCatalog } from '../database/catalogManager';
import {
  listingManager,
  type PendingNotifications,
  type StoredListing,
} from '../database/listingManager';
import { runManager, SHOP_PEAK_WINDOW_MS } from '../database/runManager';
import { userManager } from '../database/userManager';
import {
  loadReferenceSet,
  matchListing,
  type ImageEmbedder,
  type LoadedReferenceSet,
} from '../matcher/embedder';
import { isTransient, type ReferenceSet } from '../matcher/identify';
import type { MatchResult, PictureRejection } from '../matcher/matchStatus';
import type { FetchResult, Listing, ShopAdapter, ShopId } from '../shops/types';
import { errorMessage } from '../utils/async';
import { DISCORD_MESSAGE_LIMIT, clipText } from '../utils/messageLimit';
import logger, { logError } from '../utils/logger';
import { ALERT_EVERY_MS, throttledAlert, type AlertFn } from './adminAlert';

export interface ShopSummary extends Pick<
  FetchResult,
  'skippedNoId' | 'skippedExcluded' | 'skippedInvalid'
> {
  /** Card listings the shop returned (available or not). */
  listings: number;
  /** Searches cut at the page cap (FetchResult.truncated). */
  truncated?: number;
  error?: string;
}

/**
 * One check run, stored as JSON in `runs`. Rows of older versions lack newer fields: every
 * field added after the first release must be optional (runManager.parseSummary).
 */
export interface RunSummary {
  startedAt: number;
  finishedAt: number;
  shops: Partial<Record<ShopId, ShopSummary>>;
  notified: number;
  dmFailures: number;
  /** Set when the run failed outside a single shop (database, matching, sending). */
  error?: string;
  /**
   * Picture identifications this run: `decided` (the picture's card counted: rule 1, a
   * mismatch, a title naming none) and, per reason, the ones that did not count. Absent when
   * nothing was compared with every reference.
   */
  pictures?: PictureCounts;
  /**
   * Listings compared again this run after the reference switch (migration 0008): how many, how
   * many changed status, and up to MAX_REMATCH_NAMED of the changes. Absent when there was none.
   */
  rematch?: RematchCounts;
}

export interface RematchCounts {
  compared: number;
  changed: number;
  /** `#<card> <shop> <old>→<new> <url>`, at most MAX_REMATCH_NAMED. */
  changes: readonly string[];
}

/** At most this many re-match changes are named in the summary. */
const MAX_REMATCH_NAMED = 10;

export type PictureCounts = Partial<Record<'decided' | PictureRejection, number>>;

export type { PendingNotifications } from '../database/listingManager';

export interface NotificationSender {
  send(pending: PendingNotifications): Promise<{ notified: number; dmFailures: number }>;
}

export interface RunDeps {
  adapters: ShopAdapter[];
  embedder: ImageEmbedder | null;
  threshold: number;
  sender: NotificationSender;
  alertAdmin: (text: string) => Promise<void>;
  now: () => number;
  /** The check interval; listings unseen for two of them (a failing shop) are not notified. */
  intervalMs: number;
  /** Retry the admin DMs of reports whose DM failed (interactions/report.ts); never rejects. */
  retryReports?: () => Promise<unknown>;
  /**
   * Reference picture URL -> when it last failed to load. Kept across runs (bot.ts passes one
   * map for the process), so a failing reference is tried again at most once per
   * IMAGE_RETRY_MS. Without it every run tries again.
   */
  referenceFailures?: Map<string, number>;
  /**
   * Sync the catalogs that are due from laststicker (catalog/sync.ts), first in every run (also
   * without wanted cards), before the shops read the names; its own failures are alerted there.
   * A rejection is logged and the run goes on.
   */
  syncCatalogs?: () => Promise<unknown>;
}

/** A picture that could not be loaded is tried again at most once per day. */
export const IMAGE_RETRY_MS = 24 * 60 * 60 * 1000;

/** Throttle rows are kept this long past ALERT_EVERY_MS before they are pruned. */
const ALERT_PRUNE_MARGIN_MS = 24 * 60 * 60 * 1000;

/** A shop returning fewer than this share of its recent peak count alerts the admin. */
const DROP_ALERT_SHARE = 0.5;

/**
 * A window as text: days with at most one decimal (whole days print plainly); below one day it
 * switches to whole hours.
 */
export function formatWindow(ms: number): string {
  const days = ms / (24 * 60 * 60 * 1000);
  if (days < 1) {
    const hours = Math.round(ms / (60 * 60 * 1000));
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  const rounded = Math.round(days * 10) / 10;
  return rounded === 1 ? '1 day' : `${rounded} days`;
}

/**
 * True when the picture has not been judged yet, or the last attempt could not judge it:
 * `pending` (new or changed listing), `no_reference` and `model_unavailable` (both cheap to
 * retry every run), and `image_unavailable` once IMAGE_RETRY_MS has passed since that attempt
 * (also when a reference picture failed to load, so the full set is tried again).
 */
function needsMatch(l: StoredListing, now: number): boolean {
  const status = l.matchStatus;
  switch (status) {
    case 'pending':
    case 'no_reference':
    case 'model_unavailable':
      return true;
    case 'image_unavailable':
      return l.matchCheckedAt === null || now - l.matchCheckedAt >= IMAGE_RETRY_MS;
    default:
      // Exhaustive: a new status must be added to a branch above or to this list.
      status satisfies 'confirmed' | 'unconfirmed' | 'bundle' | 'mismatch';
      return false;
  }
}

/**
 * Whether the listing is worth comparing: a card someone wants in the listing's collection, or
 * a title naming no card.
 */
function wantedOrPictureOnly(l: StoredListing, wanted: Map<CollectionId, Set<CardId>>): boolean {
  if (l.idSource === 'picture' && l.cardIds.length === 0) return true;
  const ofCollection = wanted.get(l.collection);
  return ofCollection !== undefined && l.cardIds.some((id) => ofCollection.has(id));
}

/** At most this many cards are named in a log line or an alert. */
const MAX_NAMED = 10;

/**
 * One collection's reference pictures for this run: read from its catalog and embedded on
 * first use (through the embedding cache), then reused. A reference that failed to load within
 * IMAGE_RETRY_MS (`referenceFailures`) is not tried again. Placeholder and shared pictures are
 * named in one warning; load failures in one warning and a throttled admin alert.
 */
function referencesOnce(
  deps: RunDeps,
  embedder: ImageEmbedder,
  alert: AlertFn,
  collection: CollectionId,
  catalogOf: () => ReferenceCatalog
): () => Promise<LoadedReferenceSet> {
  let loading: Promise<LoadedReferenceSet> | null = null;
  const failures = deps.referenceFailures;
  return () => {
    loading ??= (async () => {
      const now = deps.now();
      const catalog = catalogOf();
      const set = await loadReferenceSet(catalog, embedder, {
        // laststicker has no scan of the card: the shop picture is used now and from now on.
        onScanMissing: (cardId) => {
          try {
            catalogManager.markScanMissing(collection, cardId, now);
          } catch (error) {
            logError(`recording the missing scan of #${cardId} failed`, error);
          }
        },
        skip: (url) => {
          const at = failures?.get(url);
          return at !== undefined && now - at < IMAGE_RETRY_MS
            ? `failed to load <t:${Math.floor(at / 1000)}:R>, tried again once a day`
            : null;
        },
      });
      const urlOf = new Map(catalog.usable.map((c) => [c.cardId, c.referenceImageUrl]));
      const failed = set.missing.filter(isTransient);
      if (failures) {
        for (const c of catalog.usable) {
          const url = c.referenceImageUrl;
          const failedNow = failed.find((m) => m.cardId === c.cardId);
          if (!failedNow) failures.delete(url);
          else if (!failures.has(url) || now - failures.get(url)! >= IMAGE_RETRY_MS) {
            failures.set(url, now);
          }
        }
      }
      const unusable = set.missing.filter(
        (m) => m.reason === 'placeholder' || m.reason === 'shared'
      );
      if (unusable.length > 0) {
        logger.warn(
          `${unusable.length} card(s) have no usable reference picture and are never identified by picture: ${unusable
            .slice(0, MAX_NAMED)
            .map((m) => `#${m.cardId} ${m.reason}`)
            .join(', ')}`
        );
      }
      if (failed.length > 0) {
        const named = failed
          .slice(0, MAX_NAMED)
          .map(
            (m) => `#${m.cardId} (${m.reason}: ${m.detail ?? '?'}, ${urlOf.get(m.cardId) ?? '?'})`
          )
          .join('; ');
        const text = `${failed.length} reference picture(s) of ${collectionName(collection)} could not be loaded this run, so no picture decides a card on its own and no mismatch is made until they load: ${named}`;
        logger.warn(text);
        // Keyed per collection: one collection's failures must not throttle another's alert.
        await alert(`reference-unavailable:${collection}`, text);
      }
      return set;
    })();
    return loading;
  };
}

/** The admin note for a listing whose picture shows another card than its title names. */
function mismatchNote(l: StoredListing, pictureCard: CardId): string {
  const [titleCard] = l.cardIds;
  const titleScore =
    l.similarity === null ? '' : ` (#${titleCard} only ${l.similarity.toFixed(2)})`;
  return (
    `Picture mismatch, not sent to users: the title says #${titleCard}, the picture shows ` +
    `#${pictureCard}${titleScore}. ${l.url} — if the title is wrong, fix it with /admin map collection:${l.collection}.`
  );
}

/**
 * Send every mismatch note that is due (listingManager.pendingMismatchNotes), throttled per
 * listing and picture card. A note that fails stays due for the next run; a throttled one (the
 * same mismatch again within a day) counts as sent.
 */
async function sendMismatchNotes(deps: RunDeps, alert: AlertFn): Promise<void> {
  for (const l of listingManager.pendingMismatchNotes()) {
    if (l.pictureCardId === null) continue;
    const outcome = await alert(
      `mismatch:${l.id}:${l.pictureCardId}`,
      mismatchNote(l, l.pictureCardId)
    );
    if (outcome !== 'failed') listingManager.markMismatchNoted(l.id, deps.now());
  }
}

function countPicture(counts: PictureCounts, result: MatchResult): void {
  const key = result.picture ? 'decided' : result.rejected;
  if (key) counts[key] = (counts[key] ?? 0) + 1;
}

interface RematchTally {
  compared: number;
  changed: number;
  changes: string[];
  /** Listings that became a mismatch: their own note is left out once the summary is sent. */
  mismatches: number[];
}

/** The old status as the new statuses name it: sammel-ente's `reference` was its confirmation. */
const asCurrent = (status: string): string => (status === 'reference' ? 'confirmed' : status);

/**
 * A listing waiting for its re-match (rematchFrom) was compared: count it unless the result is
 * retried anyway (image or model unavailable), and clear its rematchFrom. A listing that stays a
 * mismatch is marked noted: its note went out before the switch.
 */
function countRematch(
  deps: RunDeps,
  tally: RematchTally,
  l: StoredListing,
  result: MatchResult
): void {
  if (result.status === 'image_unavailable' || result.status === 'model_unavailable') return;
  const from = asCurrent(l.rematchFrom!);
  tally.compared++;
  if (from !== result.status) {
    tally.changed++;
    if (tally.changes.length < MAX_REMATCH_NAMED) {
      const card = l.cardIds.map((id) => `#${id}`).join(', ') || 'no card';
      tally.changes.push(`${card} ${l.shop} ${from}→${result.status} ${l.url}`);
    }
    if (result.status === 'mismatch') tally.mismatches.push(l.id);
    listingManager.finishRematch(l.id, null);
    return;
  }
  // Still the same mismatch: its note went out before the switch.
  listingManager.finishRematch(l.id, result.status === 'mismatch' ? deps.now() : null);
}

/**
 * The re-match's one summary for the admin instead of a note per new mismatch: sent when
 * something changed; once it is delivered, the new mismatches count as noted. A summary that
 * fails leaves their notes due, so they go out one by one instead.
 */
async function reportRematch(
  deps: RunDeps,
  alert: AlertFn,
  summary: RunSummary,
  tally: RematchTally
): Promise<void> {
  if (tally.compared === 0) return;
  const { compared, changed, changes } = tally;
  summary.rematch = { compared, changed, changes };
  if (changed === 0) return;
  const more = changed > changes.length ? `; … and ${changed - changes.length} more` : '';
  const text = clipText(
    `Reference switch: compared ${compared} listing(s) again, ${changed} changed: ${changes.join('; ')}${more}. New mismatches are not sent to users and get no note of their own.`,
    DISCORD_MESSAGE_LIMIT
  );
  // Keyed per run: a later run's re-matches are other listings, never throttled away.
  const outcome = await alert(`rematch-summary:${summary.startedAt}`, text);
  if (outcome === 'failed') return;
  for (const id of tally.mismatches) listingManager.markMismatchNoted(id, deps.now());
}

/** One collection's reference lookups for a run: the title card's picture, and the whole set. */
interface CollectionReferences {
  /**
   * The title card's reference picture: with an embedder the one its loaded vector came from (a
   * missing scan's fallback), so the title card is compared with the same picture as the set.
   * `compared` false (a listing without a picture): the catalog's, without loading the set.
   */
  referenceOf: (id: CardId, compared: boolean) => Promise<string | null>;
  references: (() => Promise<ReferenceSet>) | undefined;
}

function collectionReferences(
  deps: RunDeps,
  alert: AlertFn,
  collection: CollectionId
): CollectionReferences {
  let catalog: ReferenceCatalog | null = null;
  const catalogOf = () => (catalog ??= catalogManager.referenceCatalog(collection, deps.now()));
  let usable: Map<CardId, string> | null = null;
  const references = deps.embedder
    ? referencesOnce(deps, deps.embedder, alert, collection, catalogOf)
    : undefined;
  return {
    referenceOf: async (id, compared) => {
      usable ??= new Map(catalogOf().usable.map((c) => [c.cardId, c.referenceImageUrl]));
      const catalogUrl = usable.get(id) ?? null;
      if (!references || !compared || catalogUrl === null) return catalogUrl;
      return (await references()).urls.get(id) ?? catalogUrl;
    },
    references,
  };
}

async function matchPending(
  deps: RunDeps,
  alert: AlertFn,
  summary: RunSummary,
  stored: StoredListing[],
  fetched: Map<string, Listing>,
  wanted: Map<CollectionId, Set<CardId>>
): Promise<number[]> {
  // One warning per status and run: a missing model would otherwise log a line per listing.
  const unavailable = new Map<string, string[]>();
  const onUnavailable = (status: string, reason: string) => {
    const reasons = unavailable.get(status) ?? [];
    reasons.push(reason);
    unavailable.set(status, reasons);
  };
  // Each collection's catalog is read once per run, on first need, for both lookups below; a
  // listing is compared with its own collection's references only.
  const contexts = new Map<CollectionId, CollectionReferences>();
  const contextOf = (collection: CollectionId): CollectionReferences => {
    let context = contexts.get(collection);
    if (!context) {
      context = collectionReferences(deps, alert, collection);
      contexts.set(collection, context);
    }
    return context;
  };
  const counts: PictureCounts = {};
  const failed: string[] = [];
  const failedIds: number[] = [];
  const rematch: RematchTally = { compared: 0, changed: 0, changes: [], mismatches: [] };
  for (const l of stored) {
    if (!l.available || !needsMatch(l, deps.now()) || !wantedOrPictureOnly(l, wanted)) {
      continue;
    }
    const source = fetched.get(l.url);
    if (!source) continue;
    const [only] = l.cardIds;
    const { referenceOf, references } = contextOf(l.collection);
    try {
      const reference =
        l.cardIds.length === 1 && only !== undefined
          ? await referenceOf(only, l.imageUrl !== null)
          : null;
      const result = await matchListing(
        toShopListing(source, l),
        reference,
        deps.embedder,
        deps.threshold,
        { onUnavailable, ...(references ? { references } : {}) }
      );
      listingManager.setMatch(l.id, result, deps.now());
      countPicture(counts, result);
      if (l.rematchFrom !== null) countRematch(deps, rematch, l, result);
    } catch (error) {
      // One listing's failure (the embedding cache's database, a bug) must not stop every DM:
      // the listing stays as it was (pending or retryable) and is tried again next run.
      logError(`matching ${l.url} failed`, error);
      failed.push(`${l.url}: ${errorMessage(error)}`);
      failedIds.push(l.id);
    }
  }
  if (failed.length > 0) {
    await alert(
      'match-error',
      `Matching failed for ${failed.length} listing(s), tried again next run: ${failed.slice(0, 3).join('; ')}`
    );
  }
  if (Object.keys(counts).length > 0) summary.pictures = counts;
  await reportRematch(deps, alert, summary, rematch);
  for (const [status, reasons] of unavailable) {
    logger.warn(
      `image match unavailable (${status}) for ${reasons.length} listings this run: ${reasons[0]}`
    );
  }
  return failedIds;
}

/** The scraped listing with the stored cards, picture and id source matchListing compares. */
function toShopListing(source: Listing, l: StoredListing): Listing {
  const base = { ...source, imageUrl: l.imageUrl };
  return l.idSource === 'picture' && l.cardIds.length === 0
    ? { ...base, idSource: 'picture', cardIds: [] }
    : { ...base, idSource: 'title', cardIds: [...l.cardIds] };
}

/** The baseline for the drop check; a failed lookup is logged and only skips that check. */
function recentPeak(shop: ShopId, now: number): number | undefined {
  try {
    return runManager.shopPeakListings(shop, now);
  } catch (error) {
    logError(`shop ${shop}: reading the recent listing counts failed, drop check skipped`, error);
    return undefined;
  }
}

/** Fetch one shop and store what it returned; a failure is recorded on the shop, not thrown. */
async function checkShop(
  deps: RunDeps,
  alert: AlertFn,
  adapter: ShopAdapter,
  summary: RunSummary,
  stored: StoredListing[],
  fetched: Map<string, Listing>
): Promise<void> {
  let result: FetchResult;
  try {
    result = await adapter.fetchListings();
  } catch (error) {
    const message = errorMessage(error);
    logError(`shop ${adapter.id} failed`, error);
    summary.shops[adapter.id] = { listings: 0, error: message };
    await alert(`shop-error:${adapter.id}`, `Shop ${adapter.id} check failed: ${message}`);
    return;
  }
  const found = result.listings;
  try {
    const peak = recentPeak(adapter.id, deps.now());
    stored.push(...listingManager.upsertFromRun(adapter.id, adapter.collection, found, deps.now()));
    if (found.length > 0 && found.every((l) => !l.available)) {
      // Every card sold out at once is more likely a changed stock marker than real.
      await alert(
        `shop-all-unavailable:${adapter.id}`,
        `Shop ${adapter.id}: all ${found.length} card listings read as unavailable — check the stock marker.`
      );
    }
    if (peak !== undefined && found.length < peak * DROP_ALERT_SHARE) {
      // A pagination or markup change can leave only part of the shop readable. Measured
      // against the peak of the successful runs of the last SHOP_PEAK_WINDOW_MS (3 days, longer
      // than the 24 h throttle), a lasting drop keeps alerting daily until its last healthy run
      // is older than that (about three alerts).
      await alert(
        `shop-drop:${adapter.id}`,
        `Shop ${adapter.id}: ${found.length} card listings, down from ${peak} at most in the last ${formatWindow(SHOP_PEAK_WINDOW_MS)} — check the pagination and markup.`
      );
    }
    if (result.truncated && result.truncated.length > 0) {
      await alert(
        `shop-truncated:${adapter.id}`,
        `Shop ${adapter.id}: ${result.truncated.length} search(es) cut at the page cap, later results are not seen: ${result.truncated.join('; ')}`
      );
    }
    for (const l of found) fetched.set(l.url, l);
    // A row's collection may have no definition in this build (collectionName).
    const definition: CollectionDefinition | undefined = collectionById(adapter.collection);
    if (definition?.referenceFallbackShop === adapter.id) {
      const changed = catalogManager.updateShopPictures(
        adapter.collection,
        found.flatMap((l) => {
          const [cardId] = l.cardIds;
          return l.cardIds.length === 1 && cardId !== undefined
            ? [{ cardId, imageUrl: l.imageUrl }]
            : [];
        })
      );
      // A new reference picture may settle a mismatch either way: compare those again.
      listingManager.rematchMismatches(adapter.collection, changed);
    }
    summary.shops[adapter.id] = {
      listings: found.length,
      ...(result.skippedNoId ? { skippedNoId: result.skippedNoId } : {}),
      ...(result.skippedExcluded ? { skippedExcluded: result.skippedExcluded } : {}),
      ...(result.skippedInvalid ? { skippedInvalid: result.skippedInvalid } : {}),
      ...(result.truncated?.length ? { truncated: result.truncated.length } : {}),
    };
  } catch (error) {
    const message = `storing listings failed: ${errorMessage(error)}`;
    logError(`shop ${adapter.id}: storing listings failed`, error);
    summary.shops[adapter.id] = { listings: found.length, error: message };
    await alert(`shop-error:${adapter.id}`, `Shop ${adapter.id} check failed: ${message}`);
  }
}

/**
 * One round for all users: fetch every shop, store and match the listings, send the pending
 * notifications, record the run. Never rejects for a failing shop or step: the failure lands
 * in the summary (`shops[id].error` or `error`), the log and a throttled admin alert. Only a
 * failure to record the run itself rejects.
 */
export async function runCheck(deps: RunDeps): Promise<RunSummary> {
  const startedAt = deps.now();
  const summary: RunSummary = {
    startedAt,
    finishedAt: startedAt,
    shops: {},
    notified: 0,
    dmFailures: 0,
  };
  const alert = throttledAlert(deps.alertAdmin, deps.now);
  try {
    // Throttle rows a day past their window no longer throttle anything.
    runManager.pruneAlerts(startedAt - ALERT_EVERY_MS - ALERT_PRUNE_MARGIN_MS);
  } catch (error) {
    logError('pruning old admin alert rows failed', error);
  }

  try {
    // Before the shops read the names; also when nobody wants a card, so a new catalog fills.
    try {
      await deps.syncCatalogs?.();
    } catch (error) {
      logError('catalog sync failed', error);
    }
    const wanted = userManager.allWantedIds();
    if (wanted.size > 0) {
      const stored: StoredListing[] = [];
      const fetched = new Map<string, Listing>();
      for (const adapter of deps.adapters) {
        await checkShop(deps, alert, adapter, summary, stored, fetched);
      }
      // A listing whose match failed was never checked: not notified before a later run matches it.
      const unmatched = await matchPending(deps, alert, summary, stored, fetched, wanted);
      try {
        await sendMismatchNotes(deps, alert);
      } catch (error) {
        // The notes stay due; the users' DMs must still go out.
        logError('sending the mismatch notes failed', error);
        await alert(
          'mismatch-note-error',
          `Sending the mismatch notes failed: ${errorMessage(error)}`
        );
      }
      const now = deps.now();
      const sent = await deps.sender.send(
        listingManager.pendingNotifications({
          now,
          seenSince: now - 2 * deps.intervalMs,
          excludeIds: unmatched,
        })
      );
      summary.notified = sent.notified;
      summary.dmFailures = sent.dmFailures;
    }
  } catch (error) {
    summary.error = errorMessage(error);
    logError('check run failed', error);
    await alert('run-error', `Check run failed: ${summary.error}`);
  }
  try {
    await deps.retryReports?.();
  } catch (error) {
    logError('retrying report DMs failed', error);
  }

  summary.finishedAt = deps.now();
  runManager.record(summary);
  return summary;
}
