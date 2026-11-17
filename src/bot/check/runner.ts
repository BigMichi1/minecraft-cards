import type { CardId } from '../cards/cardId';
import { catalogManager } from '../database/catalogManager';
import {
  listingManager,
  type PendingNotifications,
  type StoredListing,
} from '../database/listingManager';
import { runManager, SHOP_PEAK_WINDOW_MS } from '../database/runManager';
import { userManager } from '../database/userManager';
import { matchListing, type ImageEmbedder } from '../matcher/embedder';
import type { FetchResult, Listing, ShopAdapter, ShopId } from '../shops/types';
import { errorMessage } from '../utils/async';
import logger, { logError } from '../utils/logger';
import { throttledAlert, type AlertFn } from './adminAlert';

export interface ShopSummary extends Pick<FetchResult, 'skippedNoId' | 'skippedInvalid'> {
  /** Card listings the shop returned (available or not). */
  listings: number;
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

async function matchPending(
  deps: RunDeps,
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
  for (const l of stored) {
    if (!l.available || !needsMatch(l, deps.now()) || !l.cardIds.some((id) => wanted.has(id))) {
      continue;
    }
    const source = fetched.get(l.url);
    if (!source) continue;
    const [only] = l.cardIds;
    const reference =
      l.cardIds.length === 1 && only !== undefined
        ? (catalogManager.getCard(only)?.referenceImageUrl ?? null)
        : null;
    const result = await matchListing(
      { ...source, cardIds: l.cardIds, imageUrl: l.imageUrl },
      reference,
      deps.embedder,
      deps.threshold,
      { onUnavailable }
    );
    listingManager.setMatch(l.id, result.status, result.similarity, deps.now());
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
      // against the peak of the successful runs of the last 3 days (longer than the 24 h
      // throttle), a lasting drop keeps alerting daily until its last healthy run is older
      // than 3 days (about three alerts).
      await alert(
        `shop-drop:${adapter.id}`,
        `Shop ${adapter.id}: ${found.length} card listings, down from ${peak} at most in the last ${SHOP_PEAK_WINDOW_MS / (24 * 60 * 60 * 1000)} days — check the pagination and markup.`
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
      ...(result.skippedInvalid ? { skippedInvalid: result.skippedInvalid } : {}),
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
      await matchPending(deps, stored, fetched, wanted);
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
