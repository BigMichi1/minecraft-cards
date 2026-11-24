import type { CardId } from '../cards/cardId';
import type { ShopId } from '../shops/types';

/**
 * Collection ids and types, kept free of runtime imports so the database schema can use them.
 * An id is stored in the database: it is never renamed and never removed (the database does not
 * check the column, so rows of a removed id would read back as a valid id). Ids are slugs
 * starting with a letter; button custom ids split on `:` and embed them unescaped
 * (`ids.test.ts`).
 */
export const COLLECTION_IDS = ['lego-minecraft-3'] as const;

export type CollectionId = (typeof COLLECTION_IDS)[number];

/**
 * The collection of every row stored before collections existed (migration 0005), and of
 * `/stock` paging buttons sent before them (`stock:<page>:<filter>`). Not a default for new
 * data: every new row and command names its collection.
 */
export const LEGACY_COLLECTION: CollectionId = 'lego-minecraft-3';

/** Where a card comes from: the laststicker sync, or the admin (`/admin catalog add`). */
export const CARD_SOURCES = ['laststicker', 'manual'] as const;
export type CardSource = (typeof CARD_SOURCES)[number];

export function isCollectionId(value: string): value is CollectionId {
  return (COLLECTION_IDS as readonly string[]).includes(value);
}

/** One card set the bot watches: its own catalog, shops and wanted lists. */
export interface CollectionDefinition<K extends CollectionId = CollectionId> {
  readonly id: K;
  /** Display name in commands and alerts. */
  readonly name: string;
  /** A checklist (`parseChecklist` form) seeded into an empty catalog at start, if any. */
  readonly starterChecklist?: string;
  /** The laststicker set its catalog is synced from (`/de/cards/<set>/`), if any. */
  readonly laststicker?: { readonly set: string };
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
}

/**
 * Card ids together with the collection they were read in: an id means a card only within its
 * collection (`12` is another card in each), so the two travel as one value.
 */
export interface CollectionCards {
  readonly collection: CollectionId;
  readonly ids: readonly CardId[];
}
