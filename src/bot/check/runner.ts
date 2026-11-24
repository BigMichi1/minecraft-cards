import type { CardId } from '../cards/cardId';
import type { CollectionDefinition, CollectionId, LEGACY_COLLECTION } from '../collections/ids';
import { collectionById, collectionName } from '../collections/index';
import { catalogManager, SCAN_RETRY_MS, type ReferenceCatalog } from '../database/catalogManager';
import {
  listingManager,
  type PendingNotifications,
  type StoredListing,
} from '../database/listingManager';
import { runManager, setShopEntry, SHOP_PEAK_WINDOW_MS } from '../database/runManager';
import { userManager } from '../database/userManager';
import {
  loadReferenceSet,
  matchListing,
  type ImageEmbedder,
  type LoadedReferenceSet,
} from '../matcher/embedder';
import { isTransient, type ReferenceSet } from '../matcher/identify';
import type {
  LegacyMatchStatus,
  MatchResult,
  MatchStatus,
  PictureRejection,
} from '../matcher/matchStatus';
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
  /**
   * Series 3's (LEGACY_COLLECTION) shop results, as in every row before collections; read and
   * write only through runManager.shopEntry and setShopEntry.
   */
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
   * The shops of every collection but series 3, whose results stay in `shops` as in every row
   * before collections (read both through runManager.shopEntry).
   */
  collections?: Partial<
    Record<Exclude<CollectionId, typeof LEGACY_COLLECTION>, Partial<Record<ShopId, ShopSummary>>>
  >;
  /**
   * Listings compared again this run after the reference switch (migration 0008): how many, how
   * many changed status, and up to MAX_REMATCH_NAMED of the changes. Absent when there was none.
   */
  rematch?: RematchCounts;
}

export interface RematchCounts {
  readonly compared: number;
  readonly changed: number;
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
 * A collection a shared run found nothing of (`emptyCollections`) is a shop error of that
 * collection, its listings kept. Only one the fetcher says may have sold out (`mayHaveSoldOut`,
 * blue-ocean: it drops sold-out singles), with nothing placed in it (no admin-mapped listing
 * either), whose recent peak (`SHOP_PEAK_WINDOW_MS`) stayed below this many listings has sold
 * out, such as blue-ocean's last series 3 singles: it is stored empty and its listings are
 * marked gone, the admin told (`shop-soldout`) while the window still holds a run with listings.
 * Without a recent successful run, with an unreadable run row or entry in the window, or when
 * the counts cannot be read, it stays a shop error.
 */
const EMPTY_COLLECTION_FLOOR = 5;

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
      const scans: ScanChanges = { missing: [], failed: [] };
      const set = await loadReferenceSet(catalog, embedder, {
        onScanMissing: (cardId) => recordMissingScan(deps, collection, cardId, now, scans),
        skip: (url) => {
          const at = failures?.get(url);
          return at !== undefined && now - at < IMAGE_RETRY_MS
            ? `failed to load <t:${Math.floor(at / 1000)}:R>, tried again once a day`
            : null;
        },
      });
      await reportScanChanges(alert, collection, catalog, set, scans);
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

/** What a reference load found out about the collection's scans. */
interface ScanChanges {
  /** Scans that answered 404/410 for the first time (recorded): the card's reference changed. */
  missing: CardId[];
  /** Missing or returning scans whose re-match or record failed: tried again next run. */
  failed: CardId[];
}

/**
 * laststicker has no scan of the card (404/410). A first miss changes its reference (to the
 * shop picture, if usable): its mismatches are compared again, then the miss is recorded, so
 * a failed re-match leaves no record and the next run tries both again. A card already recorded
 * (its SCAN_RETRY_MS retry answering 404 again) keeps its reference: the record is renewed only.
 */
function recordMissingScan(
  deps: RunDeps,
  collection: CollectionId,
  cardId: CardId,
  now: number,
  scans: ScanChanges
): void {
  try {
    const first = catalogManager.markedScans(collection, [cardId]).length === 0;
    if (first) listingManager.rematchMismatches(collection, [cardId]);
    catalogManager.markScanMissing(collection, cardId, now);
    if (first) scans.missing.push(cardId);
  } catch (error) {
    logError(`recording the missing scan of #${cardId} failed`, error);
    scans.failed.push(cardId);
  }
}

/**
 * After a reference set loaded: a scan that loaded again after its SCAN_RETRY_MS record changes
 * the card's reference back, so its mismatches are compared again before the record is cleared
 * (a failure keeps the record: retried next run). New misses and failures are named in one
 * throttled alert.
 */
async function reportScanChanges(
  alert: AlertFn,
  collection: CollectionId,
  catalog: ReferenceCatalog,
  set: LoadedReferenceSet,
  scans: ScanChanges
): Promise<void> {
  const loadedScans = catalog.usable
    .filter((c) => c.source === 'laststicker' && set.urls.get(c.cardId) === c.referenceImageUrl)
    .map((c) => c.cardId);
  try {
    const back = catalogManager.markedScans(collection, loadedScans);
    listingManager.rematchMismatches(collection, back);
    catalogManager.clearScanMissing(collection, back);
  } catch (error) {
    logError(`re-matching the cards of ${collection} whose scans loaded again failed`, error);
  }
  const { missing, failed } = scans;
  if (missing.length === 0 && failed.length === 0) return;
  const without = set.missing
    .filter((m) => m.reason === 'no_picture' && missing.includes(m.cardId))
    .map((m) => m.cardId);
  const parts = [
    missing.length > 0
      ? `${missing.length} card(s) of ${collectionName(collection)} have no laststicker scan (404/410), the shop picture stands in for ${formatWindow(SCAN_RETRY_MS)}: ${namedCards(missing)}`
      : `Missing laststicker scans of ${collectionName(collection)}`,
    ...(without.length > 0 ? [`now without any reference: ${namedCards(without)}`] : []),
    ...(failed.length > 0
      ? [`could not be recorded, tried again next run: ${namedCards(failed)}`]
      : []),
  ];
  const text = clipText(parts.join('; '), DISCORD_MESSAGE_LIMIT);
  logger.warn(text);
  // Per card list: a scan missing later the same day names other cards and must be told too.
  await alert(`scan-missing:${collection}:${[...missing, ...failed].join(',')}`, text);
}

/** `#1, #2, … and 3 more`: at most MAX_NAMED card ids. */
function namedCards(ids: readonly CardId[]): string {
  const shown = ids
    .slice(0, MAX_NAMED)
    .map((id) => `#${id}`)
    .join(', ');
  return ids.length > MAX_NAMED ? `${shown} … and ${ids.length - MAX_NAMED} more` : shown;
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

export interface RematchTally {
  compared: number;
  changed: number;
  /** One line per changed listing, at most MAX_REMATCH_NAMED. */
  changes: string[];
  /**
   * Every listing that is a mismatch after its re-match, changed or not (the old picture card and
   * whether its note went out are not known after migration 0008): named in the summary first;
   * the ones named count as noted once it is delivered, the rest keep their own notes.
   */
  mismatches: { id: number; line: string; changed: boolean }[];
}

/** The old status as the new statuses name it: sammel-ente's `reference` was its confirmation. */
function asCurrent(status: LegacyMatchStatus): MatchStatus {
  return status === 'reference' ? 'confirmed' : status;
}

/**
 * A listing waiting for its re-match (`from`, its old status) was compared: count it, unless the
 * result is retried anyway (image or model unavailable, no reference: setMatch keeps rematchFrom
 * then).
 */
function countRematch(
  tally: RematchTally,
  l: StoredListing,
  from: LegacyMatchStatus,
  result: MatchResult
): void {
  // Compared again next check (needsMatch): not the end of the re-match yet.
  if (
    result.status === 'image_unavailable' ||
    result.status === 'model_unavailable' ||
    result.status === 'no_reference'
  ) {
    return;
  }
  const before = asCurrent(from);
  tally.compared++;
  const card = l.cardIds.map((id) => `#${id}`).join(', ') || 'no card';
  const picture = result.picture ? ` (picture #${result.picture.cardId})` : '';
  const line = `${card} ${l.shop} ${before}→${result.status}${picture} ${l.url}`;
  if (result.status === 'mismatch') {
    tally.mismatches.push({ id: l.id, line, changed: before !== result.status });
  }
  if (before === result.status) return;
  tally.changed++;
  if (tally.changes.length < MAX_REMATCH_NAMED) tally.changes.push(line);
}

/** The summary text, and the mismatches it names in full (mismatches first, then the changes). */
export function rematchText(tally: RematchTally): { text: string; named: number[] } {
  let text = `Re-match against new reference pictures: compared ${tally.compared} listing(s) again, ${tally.changed} changed.`;
  const named: number[] = [];
  const room = DISCORD_MESSAGE_LIMIT - 100; // keeps space for the "… and N more" tails
  if (tally.mismatches.length > 0) {
    text += ' Mismatches, not sent to users:';
    for (const m of tally.mismatches) {
      if (text.length + m.line.length + 2 > room) break;
      text += ` ${m.line};`;
      named.push(m.id);
    }
    const rest = tally.mismatches.length - named.length;
    if (rest > 0) text += ` … and ${rest} more, each with its own note.`;
  }
  const others = tally.changes.filter((line) => !tally.mismatches.some((m) => m.line === line));
  const shown: string[] = [];
  let length = text.length + ' Other changes: '.length;
  for (const line of others) {
    if (length + line.length + 2 > room) break;
    shown.push(line);
    length += line.length + 2;
  }
  if (shown.length > 0) text += ` Other changes: ${shown.join('; ')}`;
  // Every changed listing is either a named mismatch, a shown change, or counted here.
  const namedChanged = tally.mismatches.filter((m) => m.changed && named.includes(m.id)).length;
  const hidden = tally.changed - namedChanged - shown.length;
  if (hidden > 0) {
    text += shown.length > 0 ? `; … and ${hidden} more` : ` … and ${hidden} more change(s).`;
  }
  return { text: clipText(text, DISCORD_MESSAGE_LIMIT), named };
}

/**
 * The re-match's one summary for the admin instead of a note per mismatch: sent when something
 * changed or a mismatch was found; once it is delivered, the mismatches it names count as noted.
 * A summary that fails, or a mismatch it had no room for, keeps its own note due.
 */
export async function reportRematch(
  deps: RunDeps,
  alert: AlertFn,
  summary: RunSummary,
  tally: RematchTally
): Promise<void> {
  if (tally.compared === 0) return;
  const { compared, changed, changes } = tally;
  summary.rematch = { compared, changed, changes };
  if (changed === 0 && tally.mismatches.length === 0) return;
  const { text, named } = rematchText(tally);
  // Keyed per run: a later run's re-matches are other listings, never throttled away.
  const outcome = await alert(`rematch-summary:${summary.startedAt}`, text);
  if (outcome === 'failed') return;
  listingManager.markMismatchesNoted(named, deps.now());
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
      const set = await references();
      const loaded = set.urls.get(id);
      if (loaded !== undefined) return loaded;
      // The set found no reference for it (a missing scan without fallback): none, not the
      // dead scan; a transient failure keeps the catalog's, to be retried.
      return set.missing.some((m) => m.cardId === id && !isTransient(m)) ? null : catalogUrl;
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
      if (l.rematchFrom !== null) countRematch(rematch, l, l.rematchFrom, result);
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
  try {
    await reportRematch(deps, alert, summary, rematch);
  } catch (error) {
    // The summary is the admin's; it must not cost the users their DMs. Notes stay due.
    logError('the re-match summary failed', error);
    await alert(
      'rematch-summary-error',
      `The re-match summary failed: ${errorMessage(error)}. Its mismatches get their own notes instead.`
    );
  }
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

/**
 * The recent peak, the baseline for the drop and the sold-out checks; undefined when there is none
 * or a lookup fails (logged, naming `outcome`: what the check does without it). `strict`: also
 * undefined when a run row in the window, or that shop and collection's entry in one, is
 * unreadable (it may have held the peak).
 */
function recentPeak(
  shop: ShopId,
  collection: CollectionId,
  now: number,
  outcome: string,
  strict = false
): number | undefined {
  try {
    return runManager.shopPeakListings(shop, collection, now, { strict });
  } catch (error) {
    logError(
      `shop ${shop} (${collection}): reading the recent listing counts failed, ${outcome}`,
      error
    );
    return undefined;
  }
}

/**
 * True when `shop` has stored listings in `collection` and none is available: a collection it
 * read before that has nothing left to lose. A collection it never read is not (its first empty
 * walk must be alerted). A failed lookup is logged, false.
 */
function availableNone(shop: ShopId, collection: CollectionId): boolean {
  try {
    const counts = listingManager.listingCounts(shop, collection);
    return counts.stored > 0 && counts.available === 0;
  } catch (error) {
    logError(`shop ${shop} (${collection}): counting the available listings failed`, error);
    return false;
  }
}

/** A fetch's skipped and cut counts, as the run summary files them. */
function runCounts(result: FetchResult): Partial<ShopSummary> {
  return {
    ...(result.skippedNoId ? { skippedNoId: result.skippedNoId } : {}),
    ...(result.skippedExcluded ? { skippedExcluded: result.skippedExcluded } : {}),
    ...(result.skippedInvalid ? { skippedInvalid: result.skippedInvalid } : {}),
    ...(result.truncated?.length ? { truncated: result.truncated.length } : {}),
  };
}

/**
 * Fetch one shop and store what it returned; a failure is recorded on the shop, not thrown. An
 * adapter covering several collections (a shared run: eBay, blue-ocean) is fetched once and
 * stored per collection: each listing in the collection it names (an admin-mapped one where the
 * admin put it), and every covered collection is stored, so its gone listings are marked
 * unavailable as for a shop of one collection. A failed fetch, or a failure placing its
 * listings, is alerted once under the shop alone (`shop-error:<shop>`) and touches none of its
 * collections; admin mappings outside the covered collections (`shop-outside:<shop>`), products
 * it could not read (`shop-unreadable:<shop>`: their collections mark no listing gone), and on
 * eBay cut searches and unloaded card lists (`shop-truncated:ebay`,
 * `shop-names:ebay:<collections>`), are alerted once too and the run goes on. A collection the
 * run found nothing of (`emptyCollections`) is not stored, a shop error of that collection,
 * unless it may have sold out and its recent peak stayed below EMPTY_COLLECTION_FLOOR (stored
 * empty, `shop-soldout:<shop>:<collection>`); storing fails per collection
 * (`shop-error:<shop>:<collection>`, as do the drop and foreign alerts).
 */
async function checkShop(
  deps: RunDeps,
  alert: AlertFn,
  adapter: ShopAdapter,
  summary: RunSummary,
  stored: StoredListing[],
  fetched: Map<string, Listing>
): Promise<void> {
  const covered = adapter.collections ?? [adapter.collection];
  const shared = adapter.collections !== undefined;
  // Keys and texts name the collection; a shared run's run-wide keys name the shop, not the
  // collection being stored.
  const runKey = shared ? adapter.id : `${adapter.id}:${adapter.collection}`;
  const runShop = shared ? adapter.id : `${adapter.id} (${collectionName(adapter.collection)})`;
  let result: FetchResult;
  try {
    result = await adapter.fetchListings();
  } catch (error) {
    const message = errorMessage(error);
    logError(`shop ${runShop} failed`, error);
    for (const c of covered) setShopEntry(summary, c, adapter.id, { listings: 0, error: message });
    await alert(`shop-error:${runKey}`, `Shop ${runShop} check failed: ${message}`);
    return;
  }
  if (result.truncated && result.truncated.length > 0) {
    await alert(
      `shop-truncated:${runKey}`,
      `Shop ${runShop}: ${result.truncated.length} search(es) cut at the page cap, later results are not seen: ${result.truncated.join('; ')}`
    );
  }
  if (result.namesUnknown && result.namesUnknown.length > 0) {
    // Keyed by the collections named: another unloaded card list is alerted on its own.
    await alert(
      `shop-names:${runKey}:${[...result.namesUnknown].sort().join(',')}`,
      `Shop ${runShop}: titles without a series word are not read by card name while the card list of ${result.namesUnknown.map(collectionName).join(', ')} is not loaded (laststicker sync, /admin catalog sync).`
    );
  }
  // A shared run's placement: where each listing is stored, and every URL it saw (none of
  // them is marked gone in another collection). Undefined for a shop of one collection.
  let placement: SharedPlacement | undefined;
  try {
    placement = shared ? placeShared(adapter, covered, result.listings) : undefined;
  } catch (error) {
    const message = `placing listings failed: ${errorMessage(error)}`;
    logError(`shop ${runShop}: placing listings failed`, error);
    for (const c of covered) setShopEntry(summary, c, adapter.id, { listings: 0, error: message });
    await alert(`shop-error:${runKey}`, `Shop ${runShop} check failed: ${message}`);
    return;
  }
  if (placement && placement.outsideLabels.length > 0) {
    await alert(
      `shop-outside:${runKey}`,
      clipText(
        `Shop ${runShop}: ${placement.outsideLabels.length} admin-mapped listing(s) in a collection this run does not cover are left as they are (not refreshed, not marked gone): ${placement.outsideLabels.slice(0, MAX_NAMED).join(', ')}`,
        DISCORD_MESSAGE_LIMIT
      )
    );
  }
  const empty = new Set(result.emptyCollections ?? []);
  const mayHaveSoldOut = new Set(result.mayHaveSoldOut ?? []);
  const strays = [...empty, ...mayHaveSoldOut].filter((c) => !covered.includes(c));
  if (strays.length > 0) {
    logger.warn(
      `shop ${adapter.id}: empty collection(s) ${[...new Set(strays)].join(', ')} reported outside the run's collections, ignored`
    );
  }
  // Products the shop still lists but the fetcher could not read: their collection's listings
  // are not marked gone this run (a moved URL leaves the old one unseen), nor is their own URL.
  const unreadableUrls = result.unreadableUrls ?? [];
  const unreadableCollections = new Set(result.unreadableCollections ?? []);
  if (unreadableUrls.length > 0) {
    await alert(
      `shop-unreadable:${runKey}`,
      clipText(
        `Shop ${runShop}: ${unreadableUrls.length} product(s) could not be read; no listing of ${[...unreadableCollections].map(collectionName).join(', ') || 'their collections'} is marked gone while they cannot: ${unreadableUrls.slice(0, MAX_NAMED).join(', ')}`,
        DISCORD_MESSAGE_LIMIT
      )
    );
  }
  const seenUrls = new Set([...(placement?.seenUrls ?? []), ...unreadableUrls]);
  for (const collection of covered) {
    const found = placement
      ? result.listings.filter((l) => placement.homes.get(l.url) === collection)
      : result.listings;
    // Only a collection with nothing to store at all can have sold out (an admin-mapped listing
    // placed in it says otherwise).
    const soldOutPossible =
      empty.has(collection) && mayHaveSoldOut.has(collection) && found.length === 0;
    const peak = soldOutPossible
      ? recentPeak(adapter.id, collection, deps.now(), 'kept as a shop error', true)
      : undefined;
    // Without readable recent counts, a collection read before with no available listing left
    // has nothing to lose: it is stored empty, so its peak (0) is readable again from then on.
    const nothingAvailable =
      soldOutPossible && peak === undefined && availableNone(adapter.id, collection);
    const soldOut =
      soldOutPossible && (peak !== undefined ? peak < EMPTY_COLLECTION_FLOOR : nothingAvailable);
    if (empty.has(collection) && !soldOut) {
      // Taken as a query, API or layout problem, not a sell-out (see EMPTY_COLLECTION_FLOOR).
      const message =
        (adapter.id === 'ebay'
          ? `all searches of ${collectionName(collection)} returned no usable items`
          : `no card of ${collectionName(collection)} on any page`) +
        (soldOutPossible && peak === undefined
          ? ' (no readable recent listing counts to tell a sell-out; it clears once a check reads a card of it, or, for a series read before, once none of its stored listings is available)'
          : '');
      const homes = [...(placement?.homes.values() ?? [])];
      const dropped = homes.filter((c) => c === collection).length;
      logger.warn(
        `shop ${adapter.id}: ${message}; ${dropped} listing(s) placed in it are not stored this run`
      );
      setShopEntry(summary, collection, adapter.id, {
        listings: 0,
        error: message,
        // The run's counts are filed under the adapter's collection, even when it is this one.
        ...(collection === adapter.collection ? runCounts(result) : {}),
      });
      await alert(
        `shop-error:${adapter.id}:${collection}`,
        `Shop ${adapter.id} (${collectionName(collection)}) check failed: ${message}`
      );
      continue;
    }
    if (soldOut) {
      const message = `no card of ${collectionName(collection)} on any page, at most ${peak ?? 0} listing(s) in the last ${formatWindow(SHOP_PEAK_WINDOW_MS)}: read as sold out, its listings are marked gone`;
      if (peak !== undefined && peak > 0) {
        logger.warn(`shop ${adapter.id}: ${message}`);
        await alert(
          `shop-soldout:${adapter.id}:${collection}`,
          `Shop ${adapter.id} (${collectionName(collection)}): ${message}. If the shop still sells them, check its URL and title forms (docs/shops.md).`
        );
      } else {
        // Sold out for the whole window (told already) or nothing available: nothing to mark gone.
        logger.info(`shop ${adapter.id}: ${collectionName(collection)} still sold out`);
      }
    }
    await storeShopResult(
      deps,
      alert,
      adapter,
      collection,
      shared,
      found,
      result,
      summary,
      stored,
      fetched,
      seenUrls,
      soldOut,
      !unreadableCollections.has(collection)
    );
  }
}

/** Where a shared run's listings go (placeShared). */
interface SharedPlacement {
  /** Each listing's collection; a listing without one is stored nowhere this run. */
  readonly homes: ReadonlyMap<string, CollectionId>;
  /** Every URL the run saw: none of them is marked gone in another collection. */
  readonly seenUrls: ReadonlySet<string>;
  /**
   * Labels (clipped URL and collection, for the alert and the log) of the listings in a
   * collection the run does not cover (in practice admin-mapped ones, `shop-outside`); not URLs.
   */
  readonly outsideLabels: readonly string[];
}

/**
 * Where each listing of a shared run is stored: the collection it names (`Listing.collection`, from
 * its title or URL), or, for a listing the admin mapped, the collection they put it in (kept fresh
 * there, whatever it names now). A listing whose collection the run does not cover (an admin
 * mapping into a collection without that shop's settings) is left where it is, neither refreshed
 * nor marked gone, and named in `outsideLabels`; a listing that names no collection falls back to
 * the adapter's, logged.
 */
function placeShared(
  adapter: ShopAdapter,
  covered: readonly CollectionId[],
  listings: readonly Listing[]
): SharedPlacement {
  const homes = new Map<string, CollectionId>();
  const outside: string[] = [];
  let unnamed = 0;
  for (const l of listings) {
    if (l.collection === undefined) unnamed++;
    const named = l.collection ?? adapter.collection;
    const stored = listingManager.getByUrl(l.url);
    const home = stored?.manualOverride ? stored.collection : named;
    if (covered.includes(home)) homes.set(l.url, home);
    else outside.push(`${clipText(l.url, 120)} (${home})`);
  }
  if (unnamed > 0) {
    logger.warn(
      `shop ${adapter.id}: ${unnamed} listing(s) of a shared run name no collection, stored under ${adapter.collection}`
    );
  }
  if (outside.length > 0) {
    logger.warn(
      `shop ${adapter.id}: ${outside.length} listing(s) in a collection this run does not cover, left unchanged (not refreshed, not marked gone): ${outside.slice(0, MAX_NAMED).join(', ')}`
    );
  }
  return { homes, seenUrls: new Set(listings.map((l) => l.url)), outsideLabels: outside };
}

/** Store one collection's part of a shop's fetch, and raise its alerts. */
async function storeShopResult(
  deps: RunDeps,
  alert: AlertFn,
  adapter: ShopAdapter,
  collection: CollectionId,
  shared: boolean,
  found: Listing[],
  result: FetchResult,
  summary: RunSummary,
  stored: StoredListing[],
  fetched: Map<string, Listing>,
  seenUrls?: ReadonlySet<string>,
  soldOut = false,
  markGone = true
): Promise<void> {
  const key = `${adapter.id}:${collection}`;
  const shop = `${adapter.id} (${collectionName(collection)})`;
  const record = (entry: ShopSummary) => setShopEntry(summary, collection, adapter.id, entry);
  try {
    // Read as sold out, the drop is the point: the sold-out alert already said so.
    const peak = soldOut
      ? undefined
      : recentPeak(adapter.id, collection, deps.now(), 'drop check skipped');
    const ours = listingManager.upsertFromRun(adapter.id, collection, found, deps.now(), {
      moveFromOtherCollections: shared,
      ...(seenUrls ? { seenUrls } : {}),
      markGone,
    });
    stored.push(...ours);
    // Only listings stored under this collection count here: a URL another collection holds is
    // neither matched, nor a picture source, of this one.
    const ownUrls = new Set(ours.map((l) => l.url));
    const foreign = found.filter((l) => !ownUrls.has(l.url)).map((l) => l.url);
    // A shared run (eBay, blue-ocean) moves listings between its collections and stores an
    // admin-mapped one where it is, so a foreign listing there is a listing of another shop, or a
    // mapping made during the run.
    if (foreign.length > 0) {
      const why = shared
        ? 'stored by another shop or mapped during this run'
        : 'moving a listing between collections is not supported for this shop';
      await alert(
        `shop-foreign:${key}`,
        clipText(
          `Shop ${shop}: ${foreign.length} listing(s) are stored under another collection and not read here (${why}): ${foreign.slice(0, MAX_NAMED).join(' ')}${foreign.length > MAX_NAMED ? ` … and ${foreign.length - MAX_NAMED} more` : ''}`,
          DISCORD_MESSAGE_LIMIT
        )
      );
    }
    // This collection's own listings: a URL another collection holds is counted there.
    const own = found.filter((l) => ownUrls.has(l.url));
    if (own.length > 0 && own.every((l) => !l.available)) {
      // Every card sold out at once is more likely a changed stock marker than real.
      await alert(
        `shop-all-unavailable:${key}`,
        `Shop ${shop}: all ${own.length} card listings read as unavailable — check the stock marker.`
      );
    }
    if (peak !== undefined && own.length < peak * DROP_ALERT_SHARE) {
      // A pagination or markup change can leave only part of the shop readable. Measured
      // against the peak of the successful runs of the last SHOP_PEAK_WINDOW_MS (3 days, longer
      // than the 24 h throttle), a lasting drop keeps alerting daily until its last healthy run
      // is older than that (about three alerts).
      await alert(
        `shop-drop:${key}`,
        `Shop ${shop}: ${own.length} card listings, down from ${peak} at most in the last ${formatWindow(SHOP_PEAK_WINDOW_MS)} — check the pagination and markup.`
      );
    }
    for (const l of found) if (ownUrls.has(l.url)) fetched.set(l.url, l);
    // A row's collection may have no definition in this build (collectionName).
    const definition: CollectionDefinition | undefined = collectionById(collection);
    if (definition?.referenceFallbackShop === adapter.id) {
      const changed = catalogManager.updateShopPictures(
        collection,
        found.flatMap((l) => {
          if (!ownUrls.has(l.url)) return [];
          const [cardId] = l.cardIds;
          return l.cardIds.length === 1 && cardId !== undefined
            ? [{ cardId, imageUrl: l.imageUrl }]
            : [];
        }),
        deps.now()
      );
      // A new reference picture may settle a mismatch either way: compare those again.
      try {
        listingManager.rematchMismatches(collection, changed);
      } catch (error) {
        // The listings are stored; only the re-check is lost, and these cards are known only now.
        logError(`shop ${shop}: re-matching the cards with new pictures failed`, error);
        await alert(
          // Per card list: another run's failure names other cards and must not be throttled.
          `shop-rematch:${collection}:${changed.join(',')}`,
          clipText(
            `Shop ${shop}: could not compare the mismatches of ${changed.length} card(s) again: ${namedCards(changed)} — ${errorMessage(error)}`,
            DISCORD_MESSAGE_LIMIT
          )
        );
      }
    }
    record({
      listings: own.length,
      // A shared run's skipped and cut counts are the whole run's: filed once, under the adapter's
      // `collection` (series 3 when covered, see `sharedAdapters`), not under each collection it
      // covers.
      ...(collection === adapter.collection ? runCounts(result) : {}),
    });
  } catch (error) {
    const message = `storing listings failed: ${errorMessage(error)}`;
    logError(`shop ${shop}: storing listings failed`, error);
    record({
      listings: found.length,
      error: message,
      // The run's counts are filed under the adapter's collection, even when storing failed.
      ...(collection === adapter.collection ? runCounts(result) : {}),
    });
    await alert(`shop-error:${key}`, `Shop ${shop} check failed: ${message}`);
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
