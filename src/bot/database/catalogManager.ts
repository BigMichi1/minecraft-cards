import { count, eq, inArray } from 'drizzle-orm';
import { cardType, compareCardIds, type CardId, type CardType } from '../cards/cardId';
import { parseChecklist, STARTER_CHECKLIST } from '../cards/starterCatalog';
import { db } from './db';
import { cards, wantedCards } from './schema/index';

export interface CatalogCard {
  cardId: CardId;
  type: CardType;
  name: string | null;
  referenceImageUrl: string | null;
}

export interface ImportPreview {
  counts: Record<CardType, number>;
  added: CardId[];
  removed: CardId[];
  removedStillWanted: { cardId: CardId; users: number }[];
}

function insertCards(ids: CardId[]): void {
  const now = Date.now();
  for (const cardId of ids) {
    db.insert(cards)
      .values({ cardId, type: cardType(cardId), updatedAt: now })
      .run();
  }
}

export const catalogManager = {
  /** Insert the starter catalog when `cards` is empty. */
  seedIfEmpty(): void {
    db.transaction(() => {
      const row = db.select({ n: count() }).from(cards).get();
      if ((row?.n ?? 0) > 0) return;
      insertCards(parseChecklist(STARTER_CHECKLIST).ids);
    });
  },

  knownIds(): Set<CardId> {
    return new Set(
      db
        .select({ cardId: cards.cardId })
        .from(cards)
        .all()
        .map((r) => r.cardId)
    );
  },

  getCard(id: CardId): CatalogCard | undefined {
    return db
      .select({
        cardId: cards.cardId,
        type: cards.type,
        name: cards.name,
        referenceImageUrl: cards.referenceImageUrl,
      })
      .from(cards)
      .where(eq(cards.cardId, id))
      .get();
  },

  /** Update name and reference image for catalog ids; unknown ids are ignored. */
  updateNamesAndReferences(
    entries: { cardId: CardId; name: string; imageUrl: string | null }[]
  ): void {
    const now = Date.now();
    db.transaction(() => {
      for (const e of entries) {
        db.update(cards)
          .set({ name: e.name, referenceImageUrl: e.imageUrl, updatedAt: now })
          .where(eq(cards.cardId, e.cardId))
          .run();
      }
    });
  },

  previewImport(ids: CardId[]): ImportPreview {
    const next = new Set(ids);
    const current = catalogManager.knownIds();
    const added = [...next].filter((id) => !current.has(id)).sort(compareCardIds);
    const removed = [...current].filter((id) => !next.has(id)).sort(compareCardIds);
    const counts: Record<CardType, number> = { base: 0, le: 0, xxl: 0 };
    for (const id of next) counts[cardType(id)]++;

    const removedStillWanted: { cardId: CardId; users: number }[] = [];
    if (removed.length > 0) {
      const rows = db
        .select({ cardId: wantedCards.cardId, users: count() })
        .from(wantedCards)
        .where(inArray(wantedCards.cardId, removed))
        .groupBy(wantedCards.cardId)
        .all();
      const byId = new Map(rows.map((r) => [r.cardId, r.users]));
      for (const cardId of removed) {
        const users = byId.get(cardId);
        if (users) removedStillWanted.push({ cardId, users });
      }
    }
    return { counts, added, removed, removedStillWanted };
  },

  /** Insert added ids and delete removed ones from `cards`; wanted lists are untouched. */
  applyImport(ids: CardId[]): void {
    const { added, removed } = catalogManager.previewImport(ids);
    db.transaction(() => {
      insertCards(added);
      for (const cardId of removed) db.delete(cards).where(eq(cards.cardId, cardId)).run();
    });
  },
};
