/**
 * Collection ids, kept free of other imports so the database schema can use them.
 * An id is stored in the database and is never renamed.
 */
export const COLLECTION_IDS = ['lego-minecraft-3'] as const;

export type CollectionId = (typeof COLLECTION_IDS)[number];

/** The collection of every row stored before collections existed, and of legacy custom ids. */
export const DEFAULT_COLLECTION: CollectionId = 'lego-minecraft-3';

export function isCollectionId(value: string): value is CollectionId {
  return (COLLECTION_IDS as readonly string[]).includes(value);
}
