import { count, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  cardType,
  compareCardIds,
  parseCardList,
  type CardId,
  type CardType,
} from '../cards/cardId';
import { parseChecklist, STARTER_CHECKLIST } from '../cards/starterCatalog';
import { db } from './db';
import { cards, wantedCards } from './schema/index';

export interface CatalogCard {
  cardId: CardId;
  type: CardType;
  name: string | null;
  referenceImageUrl: string | null;
  /** A puzzle card: never identified by its picture alone (docs/image-matching.md, rule 5). */
  puzzle: boolean;
}

/** A card with a reference picture, for the picture identification. */
export interface ReferenceCard {
  cardId: CardId;
  referenceImageUrl: string;
  puzzle: boolean;
}

/**
 * sammel-ente names its puzzle cards "Puzzlekarte <picture> <piece>" ("#154 Puzzlekarte
 * Oberwelt 1", 2026-11-18); that is where the catalog learns which cards are puzzle cards.
 */
function isPuzzleCardName(name: string): boolean {
  return /\bPuzzlekarte\b/i.test(name);
}

// sammel-ente's empty card ("mnc3_leer.jpg", 2026-11-18 for LE10 and LE11).
const PLACEHOLDER_FILE = /_leer\./i;

/** The picture a URL names, without query or fragment (`?ts=` changes on every upload). */
function pictureKey(url: string): string {
  const parsed = URL.parse(url);
  return parsed ? `${parsed.origin}${parsed.pathname}` : url;
}

/**
 * The cards whose reference picture is a real one: not a placeholder file (`_leer.`) and not
 * a picture the shop shows for more than one card. Neither tells cards apart, so such a card
 * has no reference (`no_reference`) and is never identified by picture.
 */
function usableReferences(rows: ReferenceCard[]): ReferenceCard[] {
  const uses = new Map<string, number>();
  for (const r of rows) {
    const key = pictureKey(r.referenceImageUrl);
    uses.set(key, (uses.get(key) ?? 0) + 1);
  }
  return rows.filter((r) => {
    const key = pictureKey(r.referenceImageUrl);
    return !PLACEHOLDER_FILE.test(key) && uses.get(key) === 1;
  });
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
  input: string,
  { checkCatalog = true }: { checkCatalog?: boolean } = {}
): CardListResult {
  const parsed = parseCardList(input);
  const known = checkCatalog ? catalogManager.knownIds() : null;
  const unknown = known ? parsed.ids.filter((id) => !known.has(id)) : [];
  const invalid = [...parsed.invalid, ...unknown];
  if (invalid.length > 0) return { ok: false, reason: 'invalid', invalid };
  if (parsed.ids.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, ids: parsed.ids };
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
        puzzle: cards.puzzle,
      })
      .from(cards)
      .where(eq(cards.cardId, id))
      .get();
  },

  /** Every card with a usable reference picture (no placeholder, none shared), in card order. */
  referenceCards(): ReferenceCard[] {
    const all = db
      .select({
        cardId: cards.cardId,
        referenceImageUrl: cards.referenceImageUrl,
        puzzle: cards.puzzle,
      })
      .from(cards)
      .where(isNotNull(cards.referenceImageUrl))
      .all()
      .flatMap((c) =>
        c.referenceImageUrl === null ? [] : [{ ...c, referenceImageUrl: c.referenceImageUrl }]
      );
    return usableReferences(all).sort((a, b) => compareCardIds(a.cardId, b.cardId));
  },

  /** The card's reference picture to compare with; null when it has none or only a placeholder. */
  usableReference(id: CardId): string | null {
    return catalogManager.referenceCards().find((c) => c.cardId === id)?.referenceImageUrl ?? null;
  },

  /**
   * Update name and reference image for catalog ids; unknown ids are ignored. An entry without
   * a picture keeps the stored reference: a listing that lost its picture must not erase it. A
   * puzzle card name (isPuzzleCardName) marks the card as a puzzle card; the mark is never
   * lifted, so a renamed listing cannot make a puzzle card count as decided by its picture.
   */
  updateNamesAndReferences(
    entries: { cardId: CardId; name: string; imageUrl: string | null }[]
  ): void {
    const now = Date.now();
    db.transaction(() => {
      for (const e of entries) {
        db.update(cards)
          .set({
            name: e.name,
            ...(e.imageUrl === null ? {} : { referenceImageUrl: e.imageUrl }),
            ...(isPuzzleCardName(e.name) ? { puzzle: true } : {}),
            updatedAt: now,
          })
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
