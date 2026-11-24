import { and, count, eq, inArray } from 'drizzle-orm';
import {
  cardType,
  compareCardIds,
  parseCardList,
  type CardId,
  type CardType,
} from '../cards/cardId';
import { parseChecklist } from '../cards/starterCatalog';
import { COLLECTIONS } from '../collections/index';
import type { CardSource, CollectionCards, CollectionId } from '../collections/ids';
import { CatalogLayoutError, type LaststickerRow } from '../catalog/laststicker';
import type { MissingReference } from '../matcher/identify';
import { db } from './db';
import { cards, catalogSyncs, wantedCards } from './schema/index';

export interface CatalogCard {
  collection: CollectionId;
  cardId: CardId;
  type: CardType;
  name: string | null;
  /** laststicker's section and type; null before the first sync and for manual cards. */
  kind: string | null;
  variant: string | null;
  source: CardSource;
  referenceImageUrl: string | null;
  /** A puzzle card: never identified by its picture alone (docs/image-matching.md, rule 5). */
  puzzle: boolean;
}

/** What a sync changed or found; every list sorted. */
export interface SyncResult {
  readonly added: readonly CardId[];
  /** laststicker cards whose earlier, non-null name changed (a first name is no rename). */
  readonly renamed: readonly CardId[];
  /** laststicker cards the rows lack: kept (they may be on missing lists), reported. */
  readonly vanished: readonly CardId[];
  /**
   * Manual cards the rows list whose note has not gone out (`listedNotedAt` null); the sync
   * marks them noted (markListedNoted) once the admin alert is delivered.
   */
  readonly nowListed: readonly CardId[];
}

/** Why a manual-card command was refused. */
export type ManualRefusal =
  | 'unknown'
  | 'not_manual'
  /** The card is already in the catalog (add). */
  | 'exists'
  /** laststicker does not list the card (release). */
  | 'not_listed';

/** A manual-card change, or why it was not made. */
export type ManualResult<R extends ManualRefusal = 'unknown' | 'not_manual'> =
  { ok: true } | { ok: false; reason: R };

/** Options of syncCollection. */
export interface SyncOptions {
  /**
   * More stored laststicker cards missing from the rows than this is taken for a partial page
   * (CatalogLayoutError, nothing changes). Default: no limit.
   */
  maxVanished?: number;
}

/** laststicker's section of the puzzle cards (live page, 2026-11-24). */
const PUZZLE_KIND = 'Puzzlekarten';

/** The usable reference pictures of one collection, and every card of it without one (and why). */
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
  /** Manual cards the paste lacks: kept, as an import never removes the admin's cards. */
  keptManual: CardId[];
  removedStillWanted: { cardId: CardId; users: number }[];
}

/**
 * A parsed card list: the ids, or why there are none: `empty` (no token at all) or `invalid`
 * (unparseable tokens, then ids not in the collection's catalog when that was checked).
 */
export type CardListResult =
  | { ok: true; ids: CardId[] }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'invalid'; invalid: string[] };

/**
 * Parse a comma separated card list; with `checkCatalog`, ids outside the collection's catalog
 * are invalid.
 */
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

function insertCards(collection: CollectionId, ids: readonly CardId[]): void {
  const now = Date.now();
  for (const cardId of ids) {
    db.insert(cards)
      .values({ collection, cardId, type: cardType(cardId), updatedAt: now })
      .run();
  }
}

function ofCard(collection: CollectionId, cardId: CardId) {
  return and(eq(cards.collection, collection), eq(cards.cardId, cardId));
}

/** Run `change` when the card exists and is manual; else say why not. */
function onManual(collection: CollectionId, cardId: CardId, change: () => void): ManualResult {
  return db.transaction((): ManualResult => {
    const row = db
      .select({ source: cards.source })
      .from(cards)
      .where(ofCard(collection, cardId))
      .get();
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.source !== 'manual') return { ok: false, reason: 'not_manual' };
    change();
    return { ok: true };
  });
}

export const catalogManager = {
  /** Insert each collection's starter checklist (`starterChecklist`) when it has no card. */
  seedIfEmpty(): void {
    for (const { id: collection, starterChecklist } of COLLECTIONS) {
      if (!starterChecklist) continue;
      db.transaction(() => {
        const row = db
          .select({ n: count() })
          .from(cards)
          .where(eq(cards.collection, collection))
          .get();
        if ((row?.n ?? 0) > 0) return;
        insertCards(collection, parseChecklist(starterChecklist).ids);
      });
    }
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

  /** The name (sammel-ente's) of every named card of the collection, for the eBay title check by name. */
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
        kind: cards.kind,
        variant: cards.variant,
        source: cards.source,
        referenceImageUrl: cards.referenceImageUrl,
        puzzleSeen: cards.puzzleSeen,
      })
      .from(cards)
      .where(ofCard(collection, id))
      .get();
    if (!row) return undefined;
    const { puzzleSeen, ...card } = row;
    return { ...card, puzzle: puzzleSeen };
  },

  /** The card's laststicker scan URL as last synced, or null. */
  laststickerPicture(collection: CollectionId, id: CardId): string | null {
    return (
      db.select({ url: cards.laststickerImageUrl }).from(cards).where(ofCard(collection, id)).get()
        ?.url ?? null
    );
  },

  /**
   * Every card of the collection's catalog, in card order, split into the usable reference pictures and the cards
   * without one: no picture yet (`no_picture`), a placeholder file (`_leer.`, `placeholder`), or
   * a picture the shop shows for more than one card (`shared`). The last two tell no card apart,
   * so such a card has no reference (`no_reference`) and is never identified by picture.
   * A picture counts as shared only when several cards of this collection show it.
   */
  referenceCatalog(collection: CollectionId): ReferenceCatalog {
    const rows = db
      .select({
        cardId: cards.cardId,
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
    for (const { cardId, url, puzzleSeen } of rows) {
      if (url === null) {
        missing.push({ cardId, reason: 'no_picture' });
      } else if (PLACEHOLDER_FILE.test(pictureKey(url))) {
        missing.push({ cardId, reason: 'placeholder' });
      } else if ((uses.get(pictureKey(url)) ?? 0) > 1) {
        missing.push({ cardId, reason: 'shared' });
      } else {
        usable.push({ cardId, referenceImageUrl: url, puzzle: puzzleSeen });
      }
    }
    return { usable, missing };
  },

  /**
   * Update the reference picture of catalog cards (sammel-ente's run); unknown cards and manual
   * cards with a picture are skipped (a manual card added without one takes the shop's once). An entry without a picture keeps the
   * stored one: a listing that lost its picture must not erase it. Names and puzzle flags come
   * from the laststicker sync only. Returns the cards whose reference picture URL changed, so
   * their mismatches are compared again.
   */
  updateReferences(
    collection: CollectionId,
    entries: { cardId: CardId; imageUrl: string | null }[]
  ): CardId[] {
    const now = Date.now();
    const changed: CardId[] = [];
    db.transaction(() => {
      for (const e of entries) {
        if (e.imageUrl === null) continue;
        const before = db
          .select({ url: cards.referenceImageUrl, source: cards.source })
          .from(cards)
          .where(ofCard(collection, e.cardId))
          .get();
        // A manual card keeps the admin's picture; one added without a picture takes the
        // shop's once.
        const manualWithPicture = before?.source === 'manual' && before.url !== null;
        if (!before || manualWithPicture || e.imageUrl === before.url) continue;
        changed.push(e.cardId);
        db.update(cards)
          .set({ referenceImageUrl: e.imageUrl, updatedAt: now })
          .where(ofCard(collection, e.cardId))
          .run();
      }
    });
    return changed;
  },

  /**
   * Apply a laststicker checklist to the collection, in one transaction: insert missing cards,
   * set name, kind, variant and scan URL of every laststicker card (and the puzzle flag for a
   * piece marker or the section `Puzzlekarten`, never cleared). Never deletes a card and never
   * changes a manual card's name, picture or kind; a manual card the rows list is reported
   * (`nowListed`) until markListedNoted. More stored cards missing than `maxVanished` is a
   * CatalogLayoutError and changes nothing.
   */
  syncCollection(
    collection: CollectionId,
    rows: readonly LaststickerRow[],
    now: number,
    { maxVanished = Number.POSITIVE_INFINITY }: SyncOptions = {}
  ): SyncResult {
    return db.transaction((tx) => {
      const stored = new Map(
        tx
          .select({
            cardId: cards.cardId,
            name: cards.name,
            source: cards.source,
            listedNotedAt: cards.listedNotedAt,
          })
          .from(cards)
          .where(eq(cards.collection, collection))
          .all()
          .map((r) => [r.cardId, r])
      );
      const added: CardId[] = [];
      const renamed: CardId[] = [];
      const nowListed: CardId[] = [];
      const listed = new Set<CardId>();
      for (const row of rows) {
        listed.add(row.cardId);
        const before = stored.get(row.cardId);
        const fields = {
          name: row.name,
          kind: row.kind,
          variant: row.variant,
          laststickerImageUrl: row.pictureUrl,
          ...(row.puzzle || row.kind === PUZZLE_KIND ? { puzzleSeen: true } : {}),
          updatedAt: now,
        };
        if (!before) {
          tx.insert(cards)
            .values({ collection, cardId: row.cardId, type: cardType(row.cardId), ...fields })
            .run();
          added.push(row.cardId);
        } else if (before.source === 'manual') {
          if (before.listedNotedAt === null) nowListed.push(row.cardId);
        } else {
          if (before.name !== null && before.name !== row.name) renamed.push(row.cardId);
          tx.update(cards).set(fields).where(ofCard(collection, row.cardId)).run();
        }
      }
      const vanished = [...stored]
        .filter(([cardId, card]) => card.source === 'laststicker' && !listed.has(cardId))
        .map(([cardId]) => cardId);
      if (vanished.length > maxVanished) {
        // Thrown inside the transaction: every write above is rolled back.
        throw new CatalogLayoutError(
          `laststicker: ${vanished.length} stored cards missing from laststicker, more than ${maxVanished}`
        );
      }
      const sorted = (list: CardId[]) => list.sort(compareCardIds);
      return {
        added: sorted(added),
        renamed: sorted(renamed),
        vanished: sorted(vanished),
        nowListed: sorted(nowListed),
      };
    });
  },

  /** Add a card laststicker lacks; `pictureUrl` (already validated) is its reference. */
  addManual(
    collection: CollectionId,
    cardId: CardId,
    name: string,
    pictureUrl: string | null,
    now: number
  ): ManualResult<'exists'> {
    return db.transaction((tx) => {
      if (tx.select({ id: cards.cardId }).from(cards).where(ofCard(collection, cardId)).get()) {
        return { ok: false, reason: 'exists' } as const;
      }
      tx.insert(cards)
        .values({
          collection,
          cardId,
          type: cardType(cardId),
          name,
          source: 'manual',
          referenceImageUrl: pictureUrl,
          updatedAt: now,
        })
        .run();
      return { ok: true } as const;
    });
  },

  editManual(
    collection: CollectionId,
    cardId: CardId,
    change: { name?: string; pictureUrl?: string },
    now: number
  ): ManualResult {
    return onManual(collection, cardId, () => {
      db.update(cards)
        .set({
          ...(change.name !== undefined ? { name: change.name } : {}),
          ...(change.pictureUrl !== undefined ? { referenceImageUrl: change.pictureUrl } : {}),
          updatedAt: now,
        })
        .where(ofCard(collection, cardId))
        .run();
    });
  },

  /**
   * Hand a manual card laststicker lists (a sync reported it, `listedNotedAt` set) to
   * laststicker: the next sync sets its name, kind and scan, a sammel-ente run its reference
   * picture. A card laststicker does not list is refused (`not_listed`): released, it would be
   * reported as vanished every day.
   */
  releaseManual(
    collection: CollectionId,
    cardId: CardId,
    now: number
  ): ManualResult<'unknown' | 'not_manual' | 'not_listed'> {
    const row = db
      .select({ source: cards.source, at: cards.listedNotedAt })
      .from(cards)
      .where(ofCard(collection, cardId))
      .get();
    if (row?.source === 'manual' && row.at === null) return { ok: false, reason: 'not_listed' };
    return onManual(collection, cardId, () => {
      db.update(cards)
        .set({ source: 'laststicker', listedNotedAt: null, updatedAt: now })
        .where(ofCard(collection, cardId))
        .run();
    });
  },

  /** Delete a manual card; missing lists keep the id, as for a catalog import. */
  removeManual(collection: CollectionId, cardId: CardId): ManualResult {
    return onManual(collection, cardId, () => {
      db.delete(cards).where(ofCard(collection, cardId)).run();
    });
  },

  /** A manual card, or why the card is none (`unknown`, `not_manual`). */
  manualCard(
    collection: CollectionId,
    cardId: CardId
  ): { ok: true; card: CatalogCard } | { ok: false; reason: 'unknown' | 'not_manual' } {
    const card = catalogManager.getCard(collection, cardId);
    if (!card) return { ok: false, reason: 'unknown' };
    if (card.source !== 'manual') return { ok: false, reason: 'not_manual' };
    return { ok: true, card };
  },

  /** Record that the admin was told laststicker lists these manual cards. */
  markListedNoted(collection: CollectionId, cardIds: readonly CardId[], now: number): void {
    if (cardIds.length === 0) return;
    db.update(cards)
      .set({ listedNotedAt: now })
      .where(
        and(
          eq(cards.collection, collection),
          eq(cards.source, 'manual'),
          inArray(cards.cardId, [...cardIds])
        )
      )
      .run();
  },

  /** How many users have the card on their missing list. */
  wantedCount(collection: CollectionId, cardId: CardId): number {
    return (
      db
        .select({ n: count() })
        .from(wantedCards)
        .where(and(eq(wantedCards.collection, collection), eq(wantedCards.cardId, cardId)))
        .get()?.n ?? 0
    );
  },

  /** When the collection's last laststicker sync was attempted, if ever. */
  syncAttemptedAt(collection: CollectionId): number | undefined {
    return db
      .select({ at: catalogSyncs.attemptedAt })
      .from(catalogSyncs)
      .where(eq(catalogSyncs.collection, collection))
      .get()?.at;
  },

  /** When the collection's last laststicker sync succeeded, if ever. */
  syncSucceededAt(collection: CollectionId): number | undefined {
    return (
      db
        .select({ at: catalogSyncs.succeededAt })
        .from(catalogSyncs)
        .where(eq(catalogSyncs.collection, collection))
        .get()?.at ?? undefined
    );
  },

  markSyncAttempt(collection: CollectionId, now: number): void {
    db.insert(catalogSyncs)
      .values({ collection, attemptedAt: now })
      .onConflictDoUpdate({ target: catalogSyncs.collection, set: { attemptedAt: now } })
      .run();
  },

  markSyncSuccess(collection: CollectionId, now: number): void {
    db.insert(catalogSyncs)
      .values({ collection, attemptedAt: now, succeededAt: now })
      .onConflictDoUpdate({ target: catalogSyncs.collection, set: { succeededAt: now } })
      .run();
  },

  previewImport({ collection, ids }: CollectionCards): ImportPreview {
    const next = new Set(ids);
    const current = catalogManager.knownIds(collection);
    const manual = new Set(
      db
        .select({ cardId: cards.cardId })
        .from(cards)
        .where(and(eq(cards.collection, collection), eq(cards.source, 'manual')))
        .all()
        .map((r) => r.cardId)
    );
    const added = [...next].filter((id) => !current.has(id)).sort(compareCardIds);
    const lacking = [...current].filter((id) => !next.has(id)).sort(compareCardIds);
    const removed = lacking.filter((id) => !manual.has(id));
    const keptManual = lacking.filter((id) => manual.has(id));
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
    return { counts, added, removed, keptManual, removedStillWanted };
  },

  /** Insert added ids and delete removed ones from `cards`; wanted lists are untouched. */
  applyImport(next: CollectionCards): void {
    const { collection } = next;
    const { added, removed } = catalogManager.previewImport(next);
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
