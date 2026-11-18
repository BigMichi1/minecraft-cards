/**
 * What one shop shows for one card, shared by `/missing status`, `/stock` and `/card`: the
 * listing that best answers "can I buy this card here", its state, and the listings on offer.
 */
import type { CardId } from '../cards/cardId';
import type { RunSummary } from '../check/runner';
import type { StoredListing } from '../database/listingManager';
import type { LatestRun } from '../database/runManager';
import type { ShopId } from '../shops/types';

/** What the cells of every card are computed from; gathered by the command, read without I/O. */
export interface CellContext {
  /** The newest readable check run, and whether a newer record could not be read. */
  latest: LatestRun;
  /** The shops this process checks; any other shop is not enabled. */
  enabledShops: readonly ShopId[];
  /** Stored listings carrying the cards asked about (others are ignored). */
  listings: StoredListing[];
  /** Current time; an auction whose end is before it counts as ended. */
  now: number;
}

/**
 * The state of one listing. Only `in_stock` can be bought: `paused` (a report holds it) and
 * `held_back` (the picture shows another card) are never sent to users until the admin acts.
 */
export type ListingState = 'in_stock' | 'sold_out' | 'ended' | 'paused' | 'held_back';

/**
 * One shop for one card: not enabled; unknown (no readable run, or nothing stored and the
 * shop's latest check failed or did not run); not listed (that check succeeded without it); or
 * its best listing. `stale` says the listing may be older than the last check; `offers` are the
 * in-stock listings, cheapest first (no price last), empty unless the best listing is in stock.
 */
export type ShopCell =
  | { kind: 'not_enabled' }
  | { kind: 'unknown' }
  | { kind: 'not_listed' }
  | {
      kind: 'listed';
      listing: StoredListing;
      state: ListingState;
      stale: boolean;
      offers: StoredListing[];
    };

export function succeeded(last: RunSummary, shop: ShopId): boolean {
  const entry = last.shops[shop];
  return entry !== undefined && entry.error === undefined;
}

/**
 * Whether `shop`'s last success is worth showing: it is enabled and its latest check failed or
 * did not run. Without a readable run nothing is shown per shop, so nothing is needed.
 */
export function needsLastSuccess(
  last: RunSummary | undefined,
  shop: ShopId,
  enabledShops: readonly ShopId[]
): boolean {
  return last !== undefined && enabledShops.includes(shop) && !succeeded(last, shop);
}

/** An auction whose end has passed is gone, even if the last check still saw it running. */
function ended(l: StoredListing, now: number): boolean {
  return l.auctionEndsAt !== null && l.auctionEndsAt < now;
}

export function listingState(l: StoredListing, now: number): ListingState {
  if (!l.available) return 'sold_out';
  if (ended(l, now)) return 'ended';
  if (l.onHold) return 'paused';
  if (l.matchStatus === 'mismatch') return 'held_back';
  return 'in_stock';
}

/**
 * Whether the listing's card number is backed by its picture (or the admin). Bundles are never
 * compared, so they never count as picture-backed.
 */
export function pictureBacked(l: StoredListing): boolean {
  return l.matchStatus === 'reference' || l.matchStatus === 'confirmed';
}

/** A listing of a shop whose latest check succeeded, but which that check did not return. */
function unseen(l: StoredListing, last: RunSummary): boolean {
  return succeeded(last, l.shop) && l.lastSeenAt < last.startedAt;
}

const TIER: Record<ListingState, number> = {
  in_stock: 0,
  paused: 1,
  held_back: 1,
  sold_out: 2,
  ended: 2,
};

const price = (l: StoredListing) => l.price?.cents ?? Number.POSITIVE_INFINITY;

/**
 * Sort key, lower is better: seen in the latest check, then in stock beats paused after a
 * report or held back as a mismatch beats sold out or ended, then a backed picture (never a
 * bundle), then the lowest price (none last).
 */
function sortKey(l: StoredListing, last: RunSummary, now: number): number[] {
  return [unseen(l, last) ? 1 : 0, TIER[listingState(l, now)], pictureBacked(l) ? 0 : 1, price(l)];
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** The listing that best answers "can I buy this card here". */
function best(candidates: StoredListing[], last: RunSummary, now: number): StoredListing {
  return candidates.reduce((a, b) =>
    compareKeys(sortKey(b, last, now), sortKey(a, last, now)) < 0 ? b : a
  );
}

const key = (shop: ShopId, card: CardId) => `${shop}\n${card}`;

/**
 * The cell of any card and shop, with the listings indexed once. An offer is an in-stock
 * listing seen as recently as the best one: when a seen listing is sold out, an in-stock one the
 * latest check no longer returned is not offered.
 */
export function shopCells(ctx: CellContext): (card: CardId, shop: ShopId) => ShopCell {
  const index = new Map<string, StoredListing[]>();
  for (const l of ctx.listings) {
    for (const card of new Set(l.cardIds)) {
      const here = index.get(key(l.shop, card));
      if (here) here.push(l);
      else index.set(key(l.shop, card), [l]);
    }
  }
  return (card, shop) => {
    if (!ctx.enabledShops.includes(shop)) return { kind: 'not_enabled' };
    const last = ctx.latest.summary;
    // Without a readable run there is no telling what any shop lists.
    if (!last) return { kind: 'unknown' };
    const here = index.get(key(shop, card));
    if (!here) return succeeded(last, shop) ? { kind: 'not_listed' } : { kind: 'unknown' };
    const listing = best(here, last, ctx.now);
    const state = listingState(listing, ctx.now);
    const stale = unseen(listing, last) || needsLastSuccess(last, shop, ctx.enabledShops);
    const offers =
      state === 'in_stock'
        ? here
            .filter(
              (l) =>
                listingState(l, ctx.now) === 'in_stock' && unseen(l, last) === unseen(listing, last)
            )
            .sort((a, b) => price(a) - price(b) || a.id - b.id)
        : [];
    return { kind: 'listed', listing, state, stale, offers };
  };
}
