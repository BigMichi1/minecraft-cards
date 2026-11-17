import type { CardId } from '../cards/cardId';
import { catalogManager } from '../database/catalogManager';
import { listingManager, type StoredListing } from '../database/listingManager';
import { runManager } from '../database/runManager';
import { userManager } from '../database/userManager';
import { matchListing, type ImageEmbedder } from '../matcher/embedder';
import type { Listing, ShopAdapter, ShopId } from '../shops/types';
import logger from '../utils/logger';

export interface RunSummary {
  startedAt: number;
  finishedAt: number;
  shops: Partial<Record<ShopId, { listings: number; error?: string; skippedNoId?: number }>>;
  notified: number;
  dmFailures: number;
}

export type PendingNotifications = Map<string, { listing: StoredListing; cardIds: CardId[] }[]>;

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
}

const ALERT_EVERY_MS = 24 * 60 * 60 * 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Statuses that mean "the picture has not been judged yet" (Task 8 resets to these on a changed image). */
function needsMatch(l: StoredListing): boolean {
  if (l.matchStatus === 'no_reference' || l.matchStatus === 'model_unavailable') return true;
  return l.matchStatus === 'unconfirmed' && l.similarity === null;
}

async function alert(deps: RunDeps, key: string, text: string): Promise<void> {
  const previous = runManager.lastAlertAt(key);
  if (!runManager.shouldAlert(key, deps.now(), ALERT_EVERY_MS)) return;
  try {
    await deps.alertAdmin(text);
  } catch (error) {
    runManager.releaseAlert(key, previous);
    logger.warn(`admin alert failed (${key}): ${errorMessage(error)}`);
  }
}

async function matchPending(
  deps: RunDeps,
  stored: StoredListing[],
  fetched: Map<string, Listing>,
  wanted: Set<CardId>
): Promise<void> {
  for (const l of stored) {
    if (!l.available || !needsMatch(l) || !l.cardIds.some((id) => wanted.has(id))) continue;
    const source = fetched.get(l.url);
    if (!source) continue;
    const reference =
      l.cardIds.length === 1
        ? (catalogManager.getCard(l.cardIds[0]!)?.referenceImageUrl ?? null)
        : null;
    const result = await matchListing(
      { ...source, cardIds: l.cardIds, imageUrl: l.imageUrl },
      reference,
      deps.embedder,
      deps.threshold
    );
    listingManager.setMatch(l.id, result.status, result.similarity);
  }
}

export async function runCheck(deps: RunDeps): Promise<RunSummary> {
  const startedAt = deps.now();
  const summary: RunSummary = {
    startedAt,
    finishedAt: startedAt,
    shops: {},
    notified: 0,
    dmFailures: 0,
  };
  const wanted = userManager.allWantedIds();

  if (wanted.size > 0) {
    const stored: StoredListing[] = [];
    const fetched = new Map<string, Listing>();

    for (const adapter of deps.adapters) {
      let found: Listing[];
      try {
        found = await adapter.fetchListings();
      } catch (error) {
        const message = errorMessage(error);
        logger.error(`shop ${adapter.id} failed: ${message}`);
        summary.shops[adapter.id] = { listings: 0, error: message };
        await alert(
          deps,
          `shop-error:${adapter.id}`,
          `Shop ${adapter.id} check failed: ${message}`
        );
        continue;
      }
      stored.push(...listingManager.upsertFromRun(adapter.id, found, deps.now()));
      for (const l of found) fetched.set(l.url, l);
      if (adapter.id === 'sammel-ente') {
        catalogManager.updateNamesAndReferences(
          found.flatMap((l) =>
            l.cardIds.length === 1 && l.cardName !== null
              ? [{ cardId: l.cardIds[0]!, name: l.cardName, imageUrl: l.imageUrl }]
              : []
          )
        );
      }
      const skipped = (adapter as { lastSkippedNoId?: number }).lastSkippedNoId;
      summary.shops[adapter.id] =
        skipped === undefined
          ? { listings: found.length }
          : { listings: found.length, skippedNoId: skipped };
    }

    await matchPending(deps, stored, fetched, wanted);
    const now = deps.now();
    const sent = await deps.sender.send(
      listingManager.pendingNotifications({ now, seenSince: now - 2 * deps.intervalMs })
    );
    summary.notified = sent.notified;
    summary.dmFailures = sent.dmFailures;
  }

  summary.finishedAt = deps.now();
  runManager.record(summary);
  return summary;
}
