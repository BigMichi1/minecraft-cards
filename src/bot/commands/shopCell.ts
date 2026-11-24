/**
 * What one shop shows for one card, shared by `/missing status`, `/stock` and `/card`: the
 * listing that best answers "can I buy this card here", its state, and the listings on offer.
 */
import type { CardId } from '../cards/cardId';
import type { RunSummary } from '../check/runner';
import type { StoredListing } from '../database/listingManager';
import { shopEntry, type LatestRun } from '../database/runManager';
import type { CollectionId } from '../collections/ids';
import type { ShopId } from '../shops/types';

/** The shops this process checks, per collection (from the adapters). */
export type EnabledShops = ReadonlyMap<CollectionId, readonly ShopId[]>;

/** The shops checked for `collection`; none for a collection nothing checks. */
export function enabledFor(enabled: EnabledShops, collection: CollectionId): readonly ShopId[] {
  return enabled.get(collection) ?? [];
}

/** What the cells of every card are computed from; gathered by the command, read without I/O. */
export interface CellContext {
  /** The collection the cards are of: its shops' results are read from the run. */
  collection: CollectionId;
  /** The newest readable check run, and whether a newer record could not be read. */
  latest: LatestRun;
  /** The shops this process checks for the collection; any other shop is not enabled. */
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
 * in-stock listings, empty unless the best listing is in stock, in the order to link them:
 * single cards backed by their picture, then other single cards, then bundles, each group
 * cheapest first (no price, or a price in another currency, last).
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

export function succeeded(last: RunSummary, collection: CollectionId, shop: ShopId): boolean {
  const entry = shopEntry(last, collection, shop);
  return entry !== undefined && entry.error === undefined;
}

/**
 * Whether `shop`'s last success is worth showing: it is enabled and its latest check failed or
 * did not run. Without a readable run nothing is shown per shop, so nothing is needed.
 */
export function needsLastSuccess(
  last: RunSummary | undefined,
  collection: CollectionId,
  shop: ShopId,
  enabledShops: readonly ShopId[]
): boolean {
  return last !== undefined && enabledShops.includes(shop) && !succeeded(last, collection, shop);
}

/** An auction whose end has passed is gone, even if the last check still saw it running. */
function ended(l: StoredListing, now: number): boolean {
  return l.auctionEndsAt !== null && l.auctionEndsAt < now;
}

/**
 * Never sent to users: a mismatch, or one from before a reference change waiting to be compared
 * again (listingManager.pendingNotifications).
 */
export function heldBack(l: StoredListing): boolean {
  return l.matchStatus === 'mismatch' || l.rematchFrom === 'mismatch';
}

export function listingState(l: StoredListing, now: number): ListingState {
  if (!l.available) return 'sold_out';
  if (ended(l, now)) return 'ended';
  if (l.onHold) return 'paused';
  if (heldBack(l)) return 'held_back';
  return 'in_stock';
}

/**
 * Whether the listing's card number is backed by its picture (or the admin). Bundles are never
 * compared, so they never count as picture-backed.
 */
export function pictureBacked(l: StoredListing): boolean {
  return l.matchStatus === 'confirmed';
}

/** A listing of a shop whose latest check succeeded, but which that check did not return. */
function unseen(l: StoredListing, last: RunSummary): boolean {
  return succeeded(last, l.collection, l.shop) && l.lastSeenAt < last.startedAt;
}

const TIER: Record<ListingState, number> = {
  in_stock: 0,
  paused: 1,
  held_back: 1,
  sold_out: 2,
  ended: 2,
};

/**
 * The currency prices are compared in: EUR (every shop's own currency) when any listing has a
 * EUR price, else the first priced listing's, so listings only in another currency still compare
 * among themselves. A price in any other currency counts as no price. Callers pass the in-stock
 * listings (or all, when none is in stock), so a sold-out EUR listing does not decide it.
 */
function referenceCurrency(listings: StoredListing[]): string {
  const priced = listings.filter((l) => l.price !== null);
  return priced.some((l) => l.price!.currency === 'EUR')
    ? 'EUR'
    : (priced[0]?.price!.currency ?? 'EUR');
}

function price(l: StoredListing, currency: string): number {
  return l.price !== null && l.price.currency === currency
    ? l.price.cents
    : Number.POSITIVE_INFINITY;
}

/** Offer group, lower first: a backed single card, another single card, a bundle. */
function offerRank(l: StoredListing): number {
  if (l.cardIds.length > 1) return 2;
  return pictureBacked(l) ? 0 : 1;
}

/**
 * Sort key, lower is better: seen in the latest check, then in stock beats paused after a
 * report or held back as a mismatch beats sold out or ended, then a backed picture (never a
 * bundle), then the lowest price (none last).
 */
function sortKey(l: StoredListing, last: RunSummary, now: number, currency: string): number[] {
  return [
    unseen(l, last) ? 1 : 0,
    TIER[listingState(l, now)],
    pictureBacked(l) ? 0 : 1,
    price(l, currency),
  ];
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** The listing that best answers "can I buy this card here". */
function best(
  candidates: StoredListing[],
  last: RunSummary,
  now: number,
  currency: string
): StoredListing {
  return candidates.reduce((a, b) =>
    compareKeys(sortKey(b, last, now, currency), sortKey(a, last, now, currency)) < 0 ? b : a
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
    if (!here) {
      return succeeded(last, ctx.collection, shop) ? { kind: 'not_listed' } : { kind: 'unknown' };
    }
    const inStock = here.filter((l) => listingState(l, ctx.now) === 'in_stock');
    const currency = referenceCurrency(inStock.length > 0 ? inStock : here);
    const listing = best(here, last, ctx.now, currency);
    const state = listingState(listing, ctx.now);
    const stale =
      unseen(listing, last) || needsLastSuccess(last, ctx.collection, shop, ctx.enabledShops);
    const offers =
      state === 'in_stock'
        ? here
            .filter(
              (l) =>
                listingState(l, ctx.now) === 'in_stock' && unseen(l, last) === unseen(listing, last)
            )
            .sort(
              (a, b) =>
                offerRank(a) - offerRank(b) ||
                compareKeys([price(a, currency), a.id], [price(b, currency), b.id])
            )
        : [];
    return { kind: 'listed', listing, state, stale, offers };
  };
}
