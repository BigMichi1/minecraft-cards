import { and, count, eq, inArray } from 'drizzle-orm';
import {
  cardType,
  compareCardIds,
  parseCardList,
  type CardId,
  type CardType,
} from '../cards/cardId';
import { parseChecklist, STARTER_CHECKLIST } from '../cards/starterCatalog';
import type { CollectionId } from '../collections/ids';
import type { MissingReference } from '../matcher/identify';
import { db } from './db';
import { cards, wantedCards } from './schema/index';

export interface CatalogCard {
  collection: CollectionId;
  cardId: CardId;
  type: CardType;
  name: string | null;
  referenceImageUrl: string | null;
  /** A puzzle card: never identified by its picture alone (docs/image-matching.md, rule 5). */
  puzzle: boolean;
}

/** The usable reference pictures, and every catalog card without one (and why). */
export interface ReferenceCatalog {
  usable: ReferenceCard[];
  missing: MissingReference[];
}

/** A card with a reference picture, for the picture identification. */
export interface ReferenceCard {
  cardId: CardId;
  referenceImageUrl: string;
  puzzle: boolean;
}

/**
 * sammel-ente names its puzzle cards "Puzzlekarte <picture> <piece>" ("#154 Puzzlekarte
 * Oberwelt 1", 2026-11-18). A card is a puzzle card when its current name says so or it ever
 * did (`puzzleSeen`): a rename cannot drop the mark, and rows stored before `puzzleSeen` count
 * by their name without a backfill.
 */
function isPuzzleCardName(name: string | null): boolean {
  return name !== null && /\bPuzzlekarte\b/i.test(name);
}

// sammel-ente's empty card ("mnc3_leer.jpg", 2026-11-18 for LE10 and LE11).
const PLACEHOLDER_FILE = /_leer\./i;

/** The picture a URL names, without query or fragment (`?ts=` changes on every upload). */
function pictureKey(url: string): string {
  const parsed = URL.parse(url);
  return parsed ? `${parsed.origin}${parsed.pathname}` : url;
}

export interface ImportPreview {
  counts: Record<CardType, number>;
  added: CardId[];
  removed: CardId[];
  removedStillWanted: { cardId: CardId; users: number }[];
}

/**
 * A parsed card list: the ids, or why there are none: `empty` (no token at all) or `invalid`
 * (unparseable tokens, then ids not in the catalog when that was checked).
 */
export type CardListResult =
  | { ok: true; ids: CardId[] }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'invalid'; invalid: string[] };

/** Parse a comma separated card list; with `checkCatalog`, ids outside the catalog are invalid. */
export function parseKnownCardList(
  collection: CollectionId,
  input: string,
  { checkCatalog = true }: { checkCatalog?: boolean } = {}
): CardListResult {
  const parsed = parseCardList(input);
  const known = checkCatalog ? catalogManager.knownIds(collection) : null;
  const unknown = known ? parsed.ids.filter((id) => !known.has(id)) : [];
  const invalid = [...parsed.invalid, ...unknown];
  if (invalid.length > 0) return { ok: false, reason: 'invalid', invalid };
  if (parsed.ids.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, ids: parsed.ids };
}

function insertCards(collection: CollectionId, ids: CardId[]): void {
  const now = Date.now();
  for (const cardId of ids) {
    db.insert(cards)
      .values({ collection, cardId, type: cardType(cardId), updatedAt: now })
      .run();
  }
}

export const catalogManager = {
  /** Insert the starter catalog when `lego-minecraft-3`, the collection it lists, has no card. */
  seedIfEmpty(): void {
    const collection: CollectionId = 'lego-minecraft-3';
    db.transaction(() => {
      const row = db
        .select({ n: count() })
        .from(cards)
        .where(eq(cards.collection, collection))
        .get();
      if ((row?.n ?? 0) > 0) return;
      insertCards(collection, parseChecklist(STARTER_CHECKLIST).ids);
    });
  },

  knownIds(collection: CollectionId): Set<CardId> {
    return new Set(
      db
        .select({ cardId: cards.cardId })
        .from(cards)
        .where(eq(cards.collection, collection))
        .all()
        .map((r) => r.cardId)
    );
  },

  /** Every named catalog card's name (sammel-ente's), for the eBay title check by name. */
  cardNames(collection: CollectionId): Map<CardId, string> {
    const names = new Map<CardId, string>();
    const rows = db
      .select({ cardId: cards.cardId, name: cards.name })
      .from(cards)
      .where(eq(cards.collection, collection))
      .all();
    for (const row of rows) {
      if (row.name) names.set(row.cardId, row.name);
    }
    return names;
  },

  getCard(collection: CollectionId, id: CardId): CatalogCard | undefined {
    const row = db
      .select({
        collection: cards.collection,
        cardId: cards.cardId,
        type: cards.type,
        name: cards.name,
        referenceImageUrl: cards.referenceImageUrl,
        puzzleSeen: cards.puzzleSeen,
      })
      .from(cards)
      .where(and(eq(cards.collection, collection), eq(cards.cardId, id)))
      .get();
    if (!row) return undefined;
    const { puzzleSeen, ...card } = row;
    return { ...card, puzzle: puzzleSeen || isPuzzleCardName(row.name) };
  },

  /**
   * Every catalog card, in card order, split into the usable reference pictures and the cards
   * without one: no picture yet (`no_picture`), a placeholder file (`_leer.`, `placeholder`), or
   * a picture the shop shows for more than one card (`shared`). The last two tell no card apart,
   * so such a card has no reference (`no_reference`) and is never identified by picture.
   * Only the collection's own cards count, also for a picture shared by several cards.
   */
  referenceCatalog(collection: CollectionId): ReferenceCatalog {
    const rows = db
      .select({
        cardId: cards.cardId,
        name: cards.name,
        url: cards.referenceImageUrl,
        puzzleSeen: cards.puzzleSeen,
      })
      .from(cards)
      .where(eq(cards.collection, collection))
      .all()
      .sort((a, b) => compareCardIds(a.cardId, b.cardId));
    const uses = new Map<string, number>();
    for (const r of rows) {
      if (r.url === null) continue;
      const key = pictureKey(r.url);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
    const usable: ReferenceCard[] = [];
    const missing: MissingReference[] = [];
    for (const { cardId, name, url, puzzleSeen } of rows) {
      if (url === null) {
        missing.push({ cardId, reason: 'no_picture' });
      } else if (PLACEHOLDER_FILE.test(pictureKey(url))) {
        missing.push({ cardId, reason: 'placeholder' });
      } else if ((uses.get(pictureKey(url)) ?? 0) > 1) {
        missing.push({ cardId, reason: 'shared' });
      } else {
        usable.push({
          cardId,
          referenceImageUrl: url,
          puzzle: puzzleSeen || isPuzzleCardName(name),
        });
      }
    }
    return { usable, missing };
  },

  /**
   * Update name and reference image for catalog ids; unknown ids are ignored. An entry without
   * a picture keeps the stored reference: a listing that lost its picture must not erase it.
   * Returns the cards whose reference picture URL changed, so their mismatches are compared
   * again.
   */
  updateNamesAndReferences(
    collection: CollectionId,
    entries: { cardId: CardId; name: string; imageUrl: string | null }[]
  ): CardId[] {
    const now = Date.now();
    const changed: CardId[] = [];
    db.transaction(() => {
      for (const e of entries) {
        const before = db
          .select({ url: cards.referenceImageUrl })
          .from(cards)
          .where(and(eq(cards.collection, collection), eq(cards.cardId, e.cardId)))
          .get();
        if (!before) continue;
        if (e.imageUrl !== null && e.imageUrl !== before.url) changed.push(e.cardId);
        db.update(cards)
          .set({
            name: e.name,
            ...(e.imageUrl === null ? {} : { referenceImageUrl: e.imageUrl }),
            ...(isPuzzleCardName(e.name) ? { puzzleSeen: true } : {}),
            updatedAt: now,
          })
          .where(and(eq(cards.collection, collection), eq(cards.cardId, e.cardId)))
          .run();
      }
    });
    return changed;
  },

  previewImport(collection: CollectionId, ids: CardId[]): ImportPreview {
    const next = new Set(ids);
    const current = catalogManager.knownIds(collection);
    const added = [...next].filter((id) => !current.has(id)).sort(compareCardIds);
    const removed = [...current].filter((id) => !next.has(id)).sort(compareCardIds);
    const counts: Record<CardType, number> = { base: 0, le: 0, xxl: 0 };
    for (const id of next) counts[cardType(id)]++;

    const removedStillWanted: { cardId: CardId; users: number }[] = [];
    if (removed.length > 0) {
      const rows = db
        .select({ cardId: wantedCards.cardId, users: count() })
        .from(wantedCards)
        .where(and(eq(wantedCards.collection, collection), inArray(wantedCards.cardId, removed)))
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
  applyImport(collection: CollectionId, ids: CardId[]): void {
    const { added, removed } = catalogManager.previewImport(collection, ids);
    db.transaction(() => {
      insertCards(collection, added);
      for (const cardId of removed) {
        db.delete(cards)
          .where(and(eq(cards.collection, collection), eq(cards.cardId, cardId)))
          .run();
      }
    });
  },
};
