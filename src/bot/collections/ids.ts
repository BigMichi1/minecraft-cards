import type { CardId } from '../cards/cardId';
import type { ShopId } from '../shops/types';

/**
 * Collection ids and types, kept free of runtime imports so the database schema can use them.
 * An id is stored in the database: it is never renamed and never removed (the database does not
 * check the column, so rows of a removed id would read back as a valid id). Ids are slugs
 * starting with a letter; button custom ids split on `:` and embed them unescaped
 * (`ids.test.ts`).
 */
export const COLLECTION_IDS = ['lego-minecraft-1', 'lego-minecraft-2', 'lego-minecraft-3'] as const;

export type CollectionId = (typeof COLLECTION_IDS)[number];

/**
 * The collection of every row stored before collections existed (migration 0005), and of
 * `/stock` paging buttons sent before them (`stock:<page>:<filter>`). Not a default for new
 * data: every new row and command names its collection.
 */
export const LEGACY_COLLECTION = 'lego-minecraft-3' satisfies CollectionId;

/** Where a card comes from: the laststicker sync, or the admin (`/admin catalog add`). */
export const CARD_SOURCES = ['laststicker', 'manual'] as const;
export type CardSource = (typeof CARD_SOURCES)[number];

export function isCollectionId(value: string): value is CollectionId {
  return (COLLECTION_IDS as readonly string[]).includes(value);
}

/** A shop category of one series: its absolute URL and the series label its titles carry. */
export interface CategoryShopSettings {
  readonly category: string;
  /** `Serie N`: sammel-ente titles name it before their pipe, collect-it's end with it. */
  readonly series: string;
}

/** How a collection's laststicker set page is read. */
export interface LaststickerSetOptions {
  /** `false`: laststicker has no scans of the set (the fallback shop's pictures serve). */
  readonly scans?: false;
  /** A raw checklist number taken as this card id (series 2's bare `XXL` is `XXL1`). */
  readonly numberAliases?: Readonly<Record<string, string>>;
}

/** How eBay is searched for a collection, and how its titles are told from other series'. */
export interface EbayCollectionSettings {
  readonly queries: readonly string[];
  /**
   * A title naming the collection; a title matching several collections' gives no ids. No `g`
   * or `y` flag (`test` would keep state between titles; refused at start).
   */
  readonly series: RegExp;
}

/** A collection's settings per shop; a collection lists only the shops that sell it. */
export interface CollectionShops {
  /** The category page (`?p=N` pages). */
  readonly 'sammel-ente'?: CategoryShopSettings;
  /** The single-card category (walked by `rel="next"`). */
  readonly 'collect-it'?: CategoryShopSettings;
  /** Series 3 only, today's category (PR 3c reads the TCC categories). */
  readonly 'blue-ocean'?: Record<string, never>;
  /** The collection's eBay searches and the series marker its titles name (`Serie 1`). */
  readonly ebay?: EbayCollectionSettings;
}

/** One card set the bot watches: its own catalog, shops and wanted lists. */
export interface CollectionDefinition<K extends CollectionId = CollectionId> {
  readonly id: K;
  /** Display name in commands and alerts. */
  readonly name: string;
  /** A checklist (`parseChecklist` form) seeded into an empty catalog at start, if any. */
  readonly starterChecklist?: string;
  /** The laststicker set its catalog is synced from (`/de/cards/<set>/`), if any. */
  readonly laststicker?: { readonly set: string } & LaststickerSetOptions;
  /**
   * The shop whose listing picture is a card's reference when laststicker has no scan of it
   * (404 or 410, or none synced yet), or a manual card has no picture of the admin's; none: such
   * a card has no reference.
   */
  readonly referenceFallbackShop?: ShopId;
  /**
   * Cards that show the same art, measured so (docs/image-matching.md): each is a twin of the
   * other whatever their reference pictures score, so the picture alone never tells them apart.
   */
  readonly knownTwins?: readonly (readonly [string, string])[];
  /** The shops that sell the collection, with their settings for it. */
  readonly shops: CollectionShops;
}

/**
 * Card ids together with the collection they were read in: an id means a card only within its
 * collection (`12` is another card in each), so the two travel as one value.
 */
export interface CollectionCards {
  readonly collection: CollectionId;
  readonly ids: readonly CardId[];
}
