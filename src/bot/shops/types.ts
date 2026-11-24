import type { CardId } from '../cards/cardId';
import type { CollectionId } from '../collections/ids';

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
   * sammel-ente and collect-it: the card name taken from the title, for the logs; catalog names
   * come from the laststicker sync only.
   */
  cardName: string | null;
  imageUrl: string | null;
  price: Money | null;
  available: boolean;
  format: ListingFormat;
  auctionEndsAt: number | null;
  /** blue-ocean only: the card number in the URL and in the image file name disagree. */
  idConflict: boolean;
  /**
   * Shared runs (eBay, blue-ocean) only: the collection the listing names, eBay's from its title,
   * blue-ocean's from its URL (one run serves every collection); other shops' listings belong to
   * their adapter's collection.
   */
  collection?: CollectionId;
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
   * counted. blue-ocean: series 1 and 2 singles whose `Nummer` is missing or differs from the
   * URL's number, a category URL without a card number, and a single's picture at a URL of no
   * known form.
   */
  skippedNoId?: number;
  /**
   * eBay items whose title cannot offer a single card of the collection it names: several series
   * or none (unless its catalog name confirms a series 3 number, see nameMatchedCardIds), a
   * collection this run does not read (`other series`), a pick list, a number range, or a
   * listing with variations. Not "without card number". sammel-ente and collect-it: card titles
   * of another series than the category's. blue-ocean: products whose title or picture
   * contradicts their URL's collection.
   */
  skippedExcluded?: number;
  /** Product boxes or items without a usable link or title. */
  skippedInvalid?: number;
  /**
   * eBay searches cut at the page cap, one note each (query, total, items read). The runner
   * sends a throttled admin alert: listings past the cap are not seen.
   */
  truncated?: string[];
  /**
   * eBay: the collections whose card list is not loaded yet, so no title without a series word
   * was read by catalog name this run (nameMatchedCardIds). The runner alerts the admin.
   */
  namesUnknown?: readonly CollectionId[];
  /**
   * A shared run's collections (a subset of the adapter's `collections`) it found nothing of:
   * eBay's whose own searches all returned no usable item, blue-ocean's with no card on any page
   * of the walk. Each is a shop error of that collection (nothing stored, its listings kept),
   * unless it is also in `mayHaveSoldOut` and its recent peak was below the runner's
   * EMPTY_COLLECTION_FLOOR: then it sold out, is stored empty and its listings are marked gone.
   */
  emptyCollections?: readonly CollectionId[];
  /**
   * blue-ocean only: the `emptyCollections` whose emptiness may be a sell-out (the shop drops
   * sold-out singles, and no product of them was seen but unreadable). eBay never sets it: empty
   * searches are a query or API problem.
   */
  mayHaveSoldOut?: readonly CollectionId[];
  /**
   * blue-ocean: the URLs of products the walk saw but could not read (excluded, without a card
   * id, a single's picture at an unknown URL form). The runner neither refreshes nor marks their
   * stored listings gone, and alerts the admin (`shop-unreadable:<shop>`).
   */
  unreadableUrls?: readonly string[];
}

/**
 * One shop's fetch, not yet bound to its collection (`shops/adapters.ts` binds one per
 * (collection, shop) the definition lists; eBay's and blue-ocean's one fetch each covers every
 * collection with that shop's settings).
 */
export interface ShopFetcher {
  readonly id: ShopId;
  fetchListings(): Promise<FetchResult>;
}

/**
 * A shop checked for one collection: its listings are stored in `collection`. A shared run (eBay,
 * blue-ocean) covers several (`collections`): each listing is stored in the collection it names
 * (`Listing.collection`), and the run's skipped counts are filed under `collection`, series 3
 * when covered (`sharedAdapters`, checked by `checkAdapters`).
 */
export interface ShopAdapter extends ShopFetcher {
  readonly collection: CollectionId;
  /**
   * Present means a shared run (eBay, blue-ocean), even with one collection: keys by the shop
   * alone, moves between collections. The collections it covers, none twice, `collection` among
   * them.
   */
  readonly collections?: readonly CollectionId[];
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

/** The shops this process checks, per collection (from the adapters). */
export type EnabledShops = ReadonlyMap<CollectionId, readonly ShopId[]>;

/**
 * Whether two series labels name one series (`Serie 1`, `Serie 01`, `1`): their numbers are
 * compared as numbers, so a zero-padded label is no other series.
 */
export function sameSeries(a: string, b: string): boolean {
  const number = (label: string) => Number(/(\d+)/.exec(label)?.[1] ?? Number.NaN);
  return number(a) === number(b);
}
