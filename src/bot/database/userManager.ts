import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { compareCardIds, type CardId } from '../cards/cardId';
import type { CollectionId } from '../collections/ids';
import { parseKnownCardList, type CardListResult } from './catalogManager';
import { db } from './db';
import { users, wantedCards } from './schema/index';

/** The list after a change (`ok`), or why nothing changed (`empty` input, `invalid` tokens). */
export type ListChange = CardListResult;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function ensureUser(tx: Tx, discordId: string): void {
  tx.insert(users).values({ discordId, createdAt: Date.now() }).onConflictDoNothing().run();
}

function ofList(discordId: string, collection: CollectionId) {
  return and(eq(wantedCards.discordId, discordId), eq(wantedCards.collection, collection));
}

function readList(tx: Tx, discordId: string, collection: CollectionId): CardId[] {
  return tx
    .select({ cardId: wantedCards.cardId })
    .from(wantedCards)
    .where(ofList(discordId, collection))
    .all()
    .map((r) => r.cardId)
    .sort(compareCardIds);
}

export const userManager = {
  /** Replace the whole list atomically; any invalid token changes nothing. */
  setList(discordId: string, collection: CollectionId, input: string): ListChange {
    const checked = parseKnownCardList(collection, input);
    if (!checked.ok) return checked;
    return db.transaction((tx) => {
      ensureUser(tx, discordId);
      tx.delete(wantedCards).where(ofList(discordId, collection)).run();
      for (const cardId of checked.ids) {
        tx.insert(wantedCards).values({ discordId, collection, cardId }).run();
      }
      return { ok: true, ids: readList(tx, discordId, collection) };
    });
  },

  addToList(discordId: string, collection: CollectionId, input: string): ListChange {
    const checked = parseKnownCardList(collection, input);
    if (!checked.ok) return checked;
    return db.transaction((tx) => {
      ensureUser(tx, discordId);
      for (const cardId of checked.ids) {
        tx.insert(wantedCards)
          .values({ discordId, collection, cardId })
          .onConflictDoNothing()
          .run();
      }
      return { ok: true, ids: readList(tx, discordId, collection) };
    });
  },

  /** Catalog membership is ignored so ids removed from the catalog can still be removed. */
  removeFromList(discordId: string, collection: CollectionId, input: string): ListChange {
    const checked = parseKnownCardList(collection, input, { checkCatalog: false });
    if (!checked.ok) return checked;
    return db.transaction((tx) => {
      ensureUser(tx, discordId);
      if (checked.ids.length > 0) {
        tx.delete(wantedCards)
          .where(and(ofList(discordId, collection), inArray(wantedCards.cardId, checked.ids)))
          .run();
      }
      return { ok: true, ids: readList(tx, discordId, collection) };
    });
  },

  clearList(discordId: string, collection: CollectionId): void {
    db.delete(wantedCards).where(ofList(discordId, collection)).run();
  },

  getList(discordId: string, collection: CollectionId): CardId[] {
    return db.transaction((tx) => readList(tx, discordId, collection));
  },

  /** Every card someone wants, per collection. */
  allWantedIds(): Map<CollectionId, Set<CardId>> {
    const result = new Map<CollectionId, Set<CardId>>();
    const rows = db
      .selectDistinct({ collection: wantedCards.collection, cardId: wantedCards.cardId })
      .from(wantedCards)
      .all();
    for (const { collection, cardId } of rows) {
      const set = result.get(collection) ?? new Set<CardId>();
      set.add(cardId);
      result.set(collection, set);
    }
    return result;
  },

  /** discordId -> which of the collection's `cardIds` that user wants (sorted). */
  usersWanting(collection: CollectionId, cardIds: CardId[]): Map<string, CardId[]> {
    const result = new Map<string, CardId[]>();
    if (cardIds.length === 0) return result;
    const rows = db
      .select({ discordId: wantedCards.discordId, cardId: wantedCards.cardId })
      .from(wantedCards)
      .where(and(eq(wantedCards.collection, collection), inArray(wantedCards.cardId, cardIds)))
      .all();
    for (const { discordId, cardId } of rows) {
      const list = result.get(discordId) ?? [];
      list.push(cardId);
      result.set(discordId, list);
    }
    for (const list of result.values()) list.sort(compareCardIds);
    return new Map([...result].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  },

  markDmFailed(discordId: string, at: number): void {
    db.transaction((tx) => {
      ensureUser(tx, discordId);
      tx.update(users).set({ dmFailedAt: at }).where(eq(users.discordId, discordId)).run();
    });
  },

  /** True when a DM to this user failed and they have not been told yet. */
  hasDmFailure(discordId: string): boolean {
    return (
      db
        .select({ id: users.discordId })
        .from(users)
        .where(and(eq(users.discordId, discordId), isNotNull(users.dmFailedAt)))
        .get() !== undefined
    );
  },

  /** Forget a recorded DM failure (the user has seen the notice). */
  clearDmFailure(discordId: string): void {
    db.update(users).set({ dmFailedAt: null }).where(eq(users.discordId, discordId)).run();
  },
};
