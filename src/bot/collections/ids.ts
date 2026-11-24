/**
 * Collection ids, kept free of other imports so the database schema can use them. An id is
 * stored in the database: it is never renamed and never removed (the database does not check
 * the column, so rows of a removed id would read back as a valid id). Ids are slugs starting
 * with a letter; button custom ids split on `:` and embed them unescaped (`ids.test.ts`).
 */
export const COLLECTION_IDS = ['lego-minecraft-3'] as const;

export type CollectionId = (typeof COLLECTION_IDS)[number];

/**
 * The collection of every row stored before collections existed (migration 0005), and of
 * `/stock` paging buttons sent before them (`stock:<page>:<filter>`). Not a default for new
 * data: every new row and command names its collection.
 */
export const LEGACY_COLLECTION: CollectionId = 'lego-minecraft-3';

export function isCollectionId(value: string): value is CollectionId {
  return (COLLECTION_IDS as readonly string[]).includes(value);
}
