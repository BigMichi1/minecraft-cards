import { COLLECTION_IDS, type CollectionId } from './ids';
import { legoMinecraft3 } from './legoMinecraft3';
import type { CollectionDefinition } from './types';

/**
 * One definition per id, filed under its own id: an id without a definition, or a definition
 * under another id, is a compile error.
 */
const DEFINITIONS: { readonly [K in CollectionId]: CollectionDefinition<K> } = {
  'lego-minecraft-3': legoMinecraft3,
};

/** Every collection, in display order (the order of COLLECTION_IDS). */
export const COLLECTIONS: readonly CollectionDefinition[] = COLLECTION_IDS.map(
  (id) => DEFINITIONS[id]
);

export function collectionById(id: CollectionId): CollectionDefinition {
  return DEFINITIONS[id];
}

/** Slash command choices for the `collection` option. */
export function collectionChoices(): { name: string; value: CollectionId }[] {
  return COLLECTIONS.map((c) => ({ name: c.name, value: c.id }));
}
