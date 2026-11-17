import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { compareCardIds, parseCardList, type CardId } from '../cards/cardId';
import { catalogManager } from './catalogManager';
import { db } from './db';
import { users, wantedCards } from './schema/index';

export type ListChange = { ok: true; ids: CardId[] } | { ok: false; invalid: string[] };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function ensureUser(tx: Tx, discordId: string): void {
  tx.insert(users).values({ discordId, createdAt: Date.now() }).onConflictDoNothing().run();
}

function readList(tx: Tx, discordId: string): CardId[] {
  return tx
    .select({ cardId: wantedCards.cardId })
    .from(wantedCards)
    .where(eq(wantedCards.discordId, discordId))
    .all()
    .map((r) => r.cardId)
    .sort(compareCardIds);
}

/** Parse input; `invalid` is unparseable tokens followed by (when checked) ids not in the catalog. */
function parseChecked(
  input: string,
  checkCatalog: boolean
): { ids: CardId[] } | { invalid: string[] } {
  const parsed = parseCardList(input);
  const unknown = checkCatalog
    ? (() => {
        const known = catalogManager.knownIds();
        return parsed.ids.filter((id) => !known.has(id));
      })()
    : [];
  const invalid = [...parsed.invalid, ...unknown];
  return invalid.length > 0 ? { invalid } : { ids: parsed.ids };
}

export const userManager = {
  /** Replace the whole list atomically; any invalid token changes nothing. */
  setList(discordId: string, input: string): ListChange {
    const checked = parseChecked(input, true);
    if ('invalid' in checked) return { ok: false, invalid: checked.invalid };
    return db.transaction((tx) => {
      ensureUser(tx, discordId);
      tx.delete(wantedCards).where(eq(wantedCards.discordId, discordId)).run();
      for (const cardId of checked.ids) tx.insert(wantedCards).values({ discordId, cardId }).run();
      return { ok: true, ids: readList(tx, discordId) };
    });
  },

  addToList(discordId: string, input: string): ListChange {
    const checked = parseChecked(input, true);
    if ('invalid' in checked) return { ok: false, invalid: checked.invalid };
    return db.transaction((tx) => {
      ensureUser(tx, discordId);
      for (const cardId of checked.ids) {
        tx.insert(wantedCards).values({ discordId, cardId }).onConflictDoNothing().run();
      }
      return { ok: true, ids: readList(tx, discordId) };
    });
  },

  /** Catalog membership is ignored so ids removed from the catalog can still be removed. */
  removeFromList(discordId: string, input: string): ListChange {
    const checked = parseChecked(input, false);
    if ('invalid' in checked) return { ok: false, invalid: checked.invalid };
    return db.transaction((tx) => {
      ensureUser(tx, discordId);
      if (checked.ids.length > 0) {
        tx.delete(wantedCards)
          .where(
            and(eq(wantedCards.discordId, discordId), inArray(wantedCards.cardId, checked.ids))
          )
          .run();
      }
      return { ok: true, ids: readList(tx, discordId) };
    });
  },

  clearList(discordId: string): void {
    db.delete(wantedCards).where(eq(wantedCards.discordId, discordId)).run();
  },

  getList(discordId: string): CardId[] {
    return db.transaction((tx) => readList(tx, discordId));
  },

  allWantedIds(): Set<CardId> {
    return new Set(
      db
        .selectDistinct({ cardId: wantedCards.cardId })
        .from(wantedCards)
        .all()
        .map((r) => r.cardId)
    );
  },

  /** discordId -> which of `cardIds` that user wants (sorted). */
  usersWanting(cardIds: CardId[]): Map<string, CardId[]> {
    const result = new Map<string, CardId[]>();
    if (cardIds.length === 0) return result;
    const rows = db.select().from(wantedCards).where(inArray(wantedCards.cardId, cardIds)).all();
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

  /** True once if a DM failure was recorded, clearing it. */
  takeDmFailure(discordId: string): boolean {
    return db.transaction((tx) => {
      const row = tx
        .select({ id: users.discordId })
        .from(users)
        .where(and(eq(users.discordId, discordId), isNotNull(users.dmFailedAt)))
        .get();
      if (!row) return false;
      tx.update(users).set({ dmFailedAt: null }).where(eq(users.discordId, discordId)).run();
      return true;
    });
  },
};
