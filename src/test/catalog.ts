import { and, eq } from 'drizzle-orm';
import type { CardId } from '../bot/cards/cardId';
import type { CollectionId } from '../bot/collections/ids';
import { catalogManager } from '../bot/database/catalogManager';
import { db } from '../bot/database/db';
import { cards } from '../bot/database/schema/index';

/**
 * Set names, puzzle flags and scan URLs (`scanUrl`) of stored catalog cards directly, as a
 * laststicker sync would, and shop pictures (`imageUrl`) as a sammel-ente run would. A seeded
 * card has no scan, so its `imageUrl` is its reference. Fields left out stay as they are;
 * unknown ids are skipped.
 */
export function setCatalogCards(
  collection: CollectionId,
  entries: {
    cardId: CardId;
    name?: string | null;
    imageUrl?: string | null;
    scanUrl?: string | null;
    puzzle?: boolean;
  }[]
): void {
  for (const e of entries) {
    db.update(cards)
      .set({
        ...(e.name !== undefined ? { name: e.name } : {}),
        ...(e.imageUrl !== undefined ? { shopImageUrl: e.imageUrl } : {}),
        ...(e.scanUrl !== undefined ? { laststickerImageUrl: e.scanUrl } : {}),
        ...(e.puzzle !== undefined ? { puzzleSeen: e.puzzle } : {}),
        updatedAt: 1,
      })
      .where(and(eq(cards.collection, collection), eq(cards.cardId, e.cardId)))
      .run();
  }
}

/** The card's reference picture URL as the matcher would use it now, or null. */
export function chosenReference(collection: CollectionId, cardId: CardId): string | null {
  return (
    catalogManager.referenceCatalog(collection).usable.find((c) => c.cardId === cardId)
      ?.referenceImageUrl ?? null
  );
}
