import type { CollectionId } from './ids';
import { legoMinecraft3 } from './legoMinecraft3';
import type { CollectionDefinition } from './types';

/** Every collection, in display order. */
export const COLLECTIONS: readonly CollectionDefinition[] = [legoMinecraft3];

const BY_ID = new Map<CollectionId, CollectionDefinition>(COLLECTIONS.map((c) => [c.id, c]));

export function collectionById(id: CollectionId): CollectionDefinition {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Collection ${id} has no definition`);
  return found;
}

/** Slash command choices for the `collection` option. */
export function collectionChoices(): { name: string; value: CollectionId }[] {
  return COLLECTIONS.map((c) => ({ name: c.name, value: c.id }));
}
