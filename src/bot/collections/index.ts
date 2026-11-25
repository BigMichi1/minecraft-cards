import { normalizeCardIdIn, type CardId, type CardIdRule } from '../cards/cardId';
import { SHOP_IDS, type ShopId } from '../shops/types';
import { COLLECTION_IDS, type CollectionDefinition, type CollectionId } from './ids';
import { legoMinecraft1 } from './legoMinecraft1';
import { legoMinecraft2 } from './legoMinecraft2';
import { legoMinecraft3 } from './legoMinecraft3';
import { turboAttax2026 } from './turboAttax2026';

/**
 * One definition per id, filed under its own id: an id without a definition, or a definition
 * under another id, is a compile error.
 */
const DEFINITIONS: { readonly [K in CollectionId]: CollectionDefinition<K> } = {
  'lego-minecraft-1': legoMinecraft1,
  'lego-minecraft-2': legoMinecraft2,
  'lego-minecraft-3': legoMinecraft3,
  'turbo-attax-2026': turboAttax2026,
};

/** Every collection, in display order (the order of COLLECTION_IDS). */
export const COLLECTIONS: readonly CollectionDefinition[] = COLLECTION_IDS.map(
  (id) => DEFINITIONS[id]
);

export function collectionById(id: CollectionId): CollectionDefinition {
  return DEFINITIONS[id];
}

/** The card id rule a collection's ids are read with. */
export function cardIdRuleOf(collection: CollectionId): CardIdRule {
  return DEFINITIONS[collection].cardIds;
}

/**
 * A canonical id under any registry collection's rule, or null. For values that carry ids of
 * every collection without naming it (button custom ids); the caller checks them against the
 * listing they belong to.
 */
export function anyCollectionCardId(raw: string): CardId | null {
  for (const definition of COLLECTIONS) {
    const id = normalizeCardIdIn(definition.cardIds, raw);
    if (id !== null) return id;
  }
  return null;
}

/**
 * The display name of a collection, or its id when no definition exists (a row the database
 * holds for an id this build does not define).
 */
export function collectionName(id: CollectionId): string {
  const known: Partial<Record<string, CollectionDefinition>> = DEFINITIONS;
  return known[id]?.name ?? id;
}

/** A collection's Kleinanzeigen search words, or null when no definition exists. */
export function collectionKleinanzeigen(id: CollectionId): string | null {
  const known: Partial<Record<string, CollectionDefinition>> = DEFINITIONS;
  return known[id]?.kleinanzeigen ?? null;
}

/**
 * The shops a collection's definition lists, in SHOP_IDS order: the columns and lines of its
 * card commands (stored listings of another shop are not shown there; none is stored, as no
 * adapter of that shop covers the collection). Every shop (SHOP_IDS) when no definition exists (a
 * database row for an id this build does not define).
 */
export function shopsOf(id: CollectionId): readonly ShopId[] {
  const known: Partial<Record<string, CollectionDefinition>> = DEFINITIONS;
  const definition = known[id];
  return definition ? SHOP_IDS.filter((shop) => definition.shops[shop] !== undefined) : SHOP_IDS;
}

/** Slash command choices for the `collection` option. */
export function collectionChoices(): { name: string; value: CollectionId }[] {
  return COLLECTIONS.map((c) => ({ name: c.name, value: c.id }));
}

/** The reply for a collection whose card list has not been synced from laststicker yet. */
export function notLoadedText(collection: CollectionId): string {
  return `The card list of ${collectionName(collection)} is not loaded yet: it comes from laststicker with the next check (/admin catalog sync loads it now).`;
}
