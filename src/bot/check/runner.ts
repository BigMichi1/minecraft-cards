import type { CardId } from '../cards/cardId';
import { catalogManager } from '../database/catalogManager';
import {
  listingManager,
  type PendingNotifications,
  type StoredListing,
} from '../database/listingManager';
import { runManager, SHOP_PEAK_WINDOW_MS } from '../database/runManager';
import { userManager } from '../database/userManager';
import {
  loadReferenceVectors,
  matchListing,
  type ImageEmbedder,
  type PictureCard,
} from '../matcher/embedder';
import type { ReferenceVector } from '../matcher/identify';
import type { FetchResult, Listing, ShopAdapter, ShopId } from '../shops/types';
import { errorMessage } from '../utils/async';
import logger, { logError } from '../utils/logger';
import { throttledAlert, type AlertFn } from './adminAlert';

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
}

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
}

/** A picture that could not be loaded is tried again at most once per day. */
export const IMAGE_RETRY_MS = 24 * 60 * 60 * 1000;

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
 * retry every run), and `image_unavailable` once IMAGE_RETRY_MS has passed since that attempt.
 */
function needsMatch(l: StoredListing, now: number): boolean {
  switch (l.matchStatus) {
    case 'pending':
    case 'no_reference':
    case 'model_unavailable':
      return true;
    case 'image_unavailable':
      return l.matchCheckedAt === null || now - l.matchCheckedAt >= IMAGE_RETRY_MS;
    default:
      return false;
  }
}

/** Whether the listing is worth comparing: a card someone wants, or a title naming no card. */
function wantedOrPictureOnly(l: StoredListing, wanted: Set<CardId>): boolean {
  if (l.idSource === 'picture' && l.cardIds.length === 0) return true;
  return l.cardIds.some((id) => wanted.has(id));
}

/**
 * Every card's reference picture, embedded on first use and then reused for the rest of the
 * run (the embeddings come from the cache). A reference that cannot be loaded is skipped, with
 * one warning per run.
 */
function referencesOnce(embedder: ImageEmbedder): () => Promise<ReferenceVector[]> {
  let loading: Promise<ReferenceVector[]> | null = null;
  return () => {
    loading ??= (async () => {
      const skipped: string[] = [];
      const vectors = await loadReferenceVectors(
        catalogManager.referenceCards(),
        embedder,
        (status, reason) => skipped.push(`${status}: ${reason}`)
      );
      if (skipped.length > 0) {
        logger.warn(
          `${skipped.length} reference picture(s) skipped for the picture identification this run, first: ${skipped[0]}`
        );
      }
      return vectors;
    })();
    return loading;
  };
}

/** The admin note for a listing whose picture shows another card than its title names. */
function mismatchNote(l: StoredListing, similarity: number | null, picture: PictureCard): string {
  const [titleCard] = l.cardIds;
  const titleScore = similarity === null ? '' : `, #${titleCard} ${similarity.toFixed(2)}`;
  return (
    `Picture mismatch, not sent to users: the title says #${titleCard}, the picture shows ` +
    `#${picture.cardId} (#${picture.cardId} ${picture.similarity.toFixed(2)}${titleScore}). ` +
    `${l.url} — if the title is wrong, fix it with /admin map.`
  );
}

async function matchPending(
  deps: RunDeps,
  alert: AlertFn,
  stored: StoredListing[],
  fetched: Map<string, Listing>,
  wanted: Set<CardId>
): Promise<void> {
  // One warning per status and run: a missing model would otherwise log a line per listing.
  const unavailable = new Map<string, string[]>();
  const onUnavailable = (status: string, reason: string) => {
    const reasons = unavailable.get(status) ?? [];
    reasons.push(reason);
    unavailable.set(status, reasons);
  };
  const references = deps.embedder ? referencesOnce(deps.embedder) : undefined;
  for (const l of stored) {
    if (!l.available || !needsMatch(l, deps.now()) || !wantedOrPictureOnly(l, wanted)) {
      continue;
    }
    const source = fetched.get(l.url);
    if (!source) continue;
    const [only] = l.cardIds;
    const reference =
      l.cardIds.length === 1 && only !== undefined ? catalogManager.usableReference(only) : null;
    const result = await matchListing(
      { ...source, cardIds: l.cardIds, imageUrl: l.imageUrl, idSource: l.idSource },
      reference,
      deps.embedder,
      deps.threshold,
      { onUnavailable, ...(references ? { references } : {}) }
    );
    listingManager.setMatch(
      l.id,
      result.status,
      result.similarity,
      deps.now(),
      result.picture?.cardId ?? null
    );
    if (result.status === 'mismatch' && result.picture) {
      await alert(`mismatch:${l.id}`, mismatchNote(l, result.similarity, result.picture));
    }
  }
  for (const [status, reasons] of unavailable) {
    logger.warn(
      `image match unavailable (${status}) for ${reasons.length} listings this run: ${reasons[0]}`
    );
  }
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
    stored.push(...listingManager.upsertFromRun(adapter.id, found, deps.now()));
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
    if (adapter.id === 'sammel-ente') {
      catalogManager.updateNamesAndReferences(
        found.flatMap((l) => {
          const [cardId] = l.cardIds;
          return l.cardIds.length === 1 && cardId !== undefined && l.cardName !== null
            ? [{ cardId, name: l.cardName, imageUrl: l.imageUrl }]
            : [];
        })
      );
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
    const wanted = userManager.allWantedIds();
    if (wanted.size > 0) {
      const stored: StoredListing[] = [];
      const fetched = new Map<string, Listing>();
      for (const adapter of deps.adapters) {
        await checkShop(deps, alert, adapter, summary, stored, fetched);
      }
      await matchPending(deps, alert, stored, fetched, wanted);
      const now = deps.now();
      const sent = await deps.sender.send(
        listingManager.pendingNotifications({ now, seenSince: now - 2 * deps.intervalMs })
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
