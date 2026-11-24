import { COLLECTION_IDS, type CollectionDefinition, type CollectionId } from './ids';
import { legoMinecraft1 } from './legoMinecraft1';
import { legoMinecraft2 } from './legoMinecraft2';
import { legoMinecraft3 } from './legoMinecraft3';

/**
 * One definition per id, filed under its own id: an id without a definition, or a definition
 * under another id, is a compile error.
 */
const DEFINITIONS: { readonly [K in CollectionId]: CollectionDefinition<K> } = {
  'lego-minecraft-1': legoMinecraft1,
  'lego-minecraft-2': legoMinecraft2,
  'lego-minecraft-3': legoMinecraft3,
};

/** Every collection, in display order (the order of COLLECTION_IDS). */
export const COLLECTIONS: readonly CollectionDefinition[] = COLLECTION_IDS.map(
  (id) => DEFINITIONS[id]
);

export function collectionById(id: CollectionId): CollectionDefinition {
  return DEFINITIONS[id];
}

/**
 * The display name of a collection, or its id when no definition exists (a row the database
 * holds for an id this build does not define).
 */
export function collectionName(id: CollectionId): string {
  const known: Partial<Record<string, CollectionDefinition>> = DEFINITIONS;
  return known[id]?.name ?? id;
}

/** Slash command choices for the `collection` option. */
export function collectionChoices(): { name: string; value: CollectionId }[] {
  return COLLECTIONS.map((c) => ({ name: c.name, value: c.id }));
}

/** The reply for a collection whose card list has not been synced from laststicker yet. */
export function notLoadedText(collection: CollectionId): string {
  return `The card list of ${collectionName(collection)} is not loaded yet: it comes from laststicker with the next check (/admin catalog sync loads it now).`;
}
