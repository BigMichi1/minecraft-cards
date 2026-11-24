import { and, eq } from 'drizzle-orm';
import type { CardId } from '../bot/cards/cardId';
import type { CollectionId } from '../bot/collections/ids';
import { db } from '../bot/database/db';
import { cards } from '../bot/database/schema/index';

/**
 * Set names and puzzle flags of stored catalog cards directly, as a laststicker sync would, and
 * reference pictures as a sammel-ente run would (also on manual cards, which that run skips).
 * Fields left out stay as they are; unknown ids are skipped.
 */
export function setCatalogCards(
  collection: CollectionId,
  entries: { cardId: CardId; name?: string | null; imageUrl?: string | null; puzzle?: boolean }[]
): void {
  for (const e of entries) {
    db.update(cards)
      .set({
        ...(e.name !== undefined ? { name: e.name } : {}),
        ...(e.imageUrl !== undefined ? { referenceImageUrl: e.imageUrl } : {}),
        ...(e.puzzle !== undefined ? { puzzleSeen: e.puzzle } : {}),
        updatedAt: 1,
      })
      .where(and(eq(cards.collection, collection), eq(cards.cardId, e.cardId)))
      .run();
  }
}
