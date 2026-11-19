import type { CardId } from '../cards/cardId';

export const SHOP_IDS = ['sammel-ente', 'blue-ocean', 'collect-it', 'ebay'] as const;
export type ShopId = (typeof SHOP_IDS)[number];

/** `shop`: a shop's own price; eBay listings are auctions or fixed price ("Buy It Now"). */
export const LISTING_FORMATS = ['shop', 'auction', 'fixed_price'] as const;
export type ListingFormat = (typeof LISTING_FORMATS)[number];

/**
 * Where a listing's card ids come from: its `title` (every shop), or, for an eBay title that
 * names no card but passes every single-card check, its `picture` (matcher/identify.ts).
 */
export const ID_SOURCES = ['title', 'picture'] as const;
export type IdSource = (typeof ID_SOURCES)[number];

export interface Money {
  cents: number;
  currency: string;
}

interface ListingFields {
  shop: ShopId;
  url: string;
  title: string;
  /**
   * sammel-ente and collect-it: the card name taken from the title. Only sammel-ente's names
   * feed the catalog.
   */
  cardName: string | null;
  imageUrl: string | null;
  price: Money | null;
  available: boolean;
  format: ListingFormat;
  auctionEndsAt: number | null;
  /** blue-ocean only: the card number in the URL and in the image file name disagree. */
  idConflict: boolean;
}

/**
 * A listing as a shop returned it. Its title names its cards (`idSource` absent or `title`),
 * or, eBay only, it names none but could be one single card (`idSource` `picture`, no card
 * ids): the picture decides the card (docs/image-matching.md, rule 4).
 */
export type Listing = ListingFields &
  ({ idSource?: 'title'; cardIds: CardId[] } | { idSource: 'picture'; cardIds: [] });

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * One fetch of a shop. The skipped counts go into the run summary (`/admin status`), so a
 * parser that silently drops more than usual shows up there.
 */
export interface FetchResult {
  listings: Listing[];
  /**
   * Items whose card number could not be read: sammel-ente titles with a "| #" number that does
   * not parse, eBay titles naming no card (but not the picture candidates, which are listings
   * with `idSource` `picture`). Other sammel-ente products (boosters, puzzle packs) are not
   * counted.
   */
  skippedNoId?: number;
  /**
   * eBay items whose title cannot offer a series 3 single card: series 1 or 2, no series word
   * (unless its catalog name confirms its number, see nameMatchedCardIds), a pick list, a number
   * range, or a listing with variations. Not "without card number".
   */
  skippedExcluded?: number;
  /** Product boxes or items without a usable link or title. */
  skippedInvalid?: number;
  /**
   * eBay searches cut at the page cap, one note each (query, total, items read). The runner
   * sends a throttled admin alert: listings past the cap are not seen.
   */
  truncated?: string[];
}

export interface ShopAdapter {
  readonly id: ShopId;
  fetchListings(): Promise<FetchResult>;
}

/**
 * A shop answered, but not with what a working shop sends: no card on any page, a page that
 * is not a category page (bot wall, maintenance), a page past the first without products, or
 * eBay searches that all came back empty; on eBay also a walk ending further below the total
 * than its tolerance, a first page with neither items nor total, and an answer of the wrong
 * shape. On collect-it, which hides sold-out cards, also any walk it cannot finish (a
 * missing, unreadable or wrong canonical or next link, the page cap), a walk that does not add
 * up to the shop's article total or has a short middle page, and any product box it cannot
 * read. The runner treats it like a failed fetch.
 */
export class ShopLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopLayoutError';
  }
}

/**
 * Test seam: how to wait (default `sleep`) and how long (default 1500 ms) between two page
 * requests.
 */
export interface AdapterOptions {
  sleep?: (ms: number) => Promise<void>;
  delayMs?: number;
}
