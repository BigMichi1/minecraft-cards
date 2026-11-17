import type { CardId } from '../cards/cardId';

export const SHOP_IDS = ['sammel-ente', 'blue-ocean', 'ebay'] as const;
export type ShopId = (typeof SHOP_IDS)[number];

/** `shop`: a shop's own price; eBay listings are auctions or fixed price ("Buy It Now"). */
export const LISTING_FORMATS = ['shop', 'auction', 'fixed_price'] as const;
export type ListingFormat = (typeof LISTING_FORMATS)[number];

export interface Money {
  cents: number;
  currency: string;
}

export interface Listing {
  shop: ShopId;
  url: string;
  title: string;
  cardIds: CardId[];
  /** sammel-ente only: the card name taken from the title. */
  cardName: string | null;
  imageUrl: string | null;
  price: Money | null;
  available: boolean;
  format: ListingFormat;
  auctionEndsAt: number | null;
  /** blue-ocean only: the card number in the URL and in the image file name disagree. */
  idConflict: boolean;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * One fetch of a shop. The skipped counts go into the run summary (`/admin status`), so a
 * parser that silently drops more than usual shows up there.
 */
export interface FetchResult {
  listings: Listing[];
  /** Products or items read but without a card number (puzzle packs, eBay titles naming none). */
  skippedNoId?: number;
  /** Product boxes or items without a usable link or title. */
  skippedInvalid?: number;
}

export interface ShopAdapter {
  readonly id: ShopId;
  fetchListings(): Promise<FetchResult>;
}

/**
 * A shop answered, but not with what a working shop sends: no card on any page, a page that
 * is not a category page (bot wall, maintenance), a page past the first without products, or
 * eBay searches that all came back empty. The runner treats it like a failed fetch.
 */
export class ShopLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopLayoutError';
  }
}

/** Test seam: how to wait (default `sleep`) and how long (default 1500 ms) between two page requests. */
export interface AdapterOptions {
  sleep?: (ms: number) => Promise<void>;
  delayMs?: number;
}
