import type { CardId } from '../cards/cardId';

export type ShopId = 'sammel-ente' | 'blue-ocean' | 'ebay';

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
  format: 'shop' | 'auction' | 'fixed_price';
  auctionEndsAt: number | null;
  /** blue-ocean only: the card number in the URL and in the image file name disagree. */
  idConflict: boolean;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface ShopAdapter {
  id: ShopId;
  fetchListings(): Promise<Listing[]>;
}

/** A shop page was fetched but no card could be parsed from the whole run (layout change, bot wall). */
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
