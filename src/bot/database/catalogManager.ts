import { and, count, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  cardType,
  compareCardIds,
  parseCardList,
  type CardId,
  type CardType,
} from '../cards/cardId';
import { parseChecklist } from '../cards/starterCatalog';
import { COLLECTIONS, collectionById } from '../collections/index';
import type {
  CardSource,
  CollectionCards,
  CollectionDefinition,
  CollectionId,
} from '../collections/ids';
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
  /** The admin's picture of a manual card; null for laststicker cards (see referenceCatalog). */
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
  /**
   * Stored cards whose chosen reference changed (a new or changed scan, a cleared missing-scan
   * mark, a released card); added cards are left out: their mismatches are compared again.
   */
  readonly repictured: readonly CardId[];
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

/**
 * Where a card's reference picture comes from: laststicker's scan, the collection's fallback
 * shop (`referenceFallbackShop`: no scan, or a manual card without the admin's picture), or the
 * admin's picture of a manual card.
 */
export type ReferenceSource = 'laststicker' | 'shop' | 'manual';

/** A card with a reference picture, for the picture identification. */
export type ReferenceCard = {
  cardId: CardId;
  referenceImageUrl: string;
  puzzle: boolean;
  /** One of the collection's `knownTwins`: never told apart from its twin by the picture. */
  knownTwin?: true;
} & ChosenSource;

/**
 * The source and, for a laststicker scan only, the shop picture to use instead when the scan
 * answers 404 or 410 (embedder's loadReferenceSet); null when there is none, or it is a
 * placeholder or shown for several cards.
 */
type ChosenSource =
  | { source: 'laststicker'; fallbackUrl: string | null }
  | { source: 'shop' | 'manual'; fallbackUrl: null };

/** A scan that answered 404 or 410 is tried again this long after (laststicker may add it). */
export const SCAN_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** The stored pictures of a card that its reference is chosen from. */
interface PictureColumns {
  source: CardSource;
  referenceImageUrl: string | null;
  shopImageUrl: string | null;
  laststickerImageUrl: string | null;
  laststickerScanMissingAt: number | null;
}

const PICTURE_COLUMNS = {
  source: cards.source,
  referenceImageUrl: cards.referenceImageUrl,
  shopImageUrl: cards.shopImageUrl,
  laststickerImageUrl: cards.laststickerImageUrl,
  laststickerScanMissingAt: cards.laststickerScanMissingAt,
};

/**
 * The one rule for a card's reference picture: a manual card's is the admin's picture, else the
 * shop's; a laststicker card's is its scan (the shop picture as fallback), unless the scan
 * answered 404 or 410 within SCAN_RETRY_MS (or none is synced yet), then the shop picture.
 * Null: no picture at all.
 */
function chooseReference(
  row: PictureColumns,
  now: number
): ({ url: string } & ChosenSource) | null {
  if (row.source === 'manual') {
    if (row.referenceImageUrl !== null) {
      return { url: row.referenceImageUrl, source: 'manual', fallbackUrl: null };
    }
  } else {
    const missing =
      row.laststickerScanMissingAt !== null && now - row.laststickerScanMissingAt < SCAN_RETRY_MS;
    if (row.laststickerImageUrl !== null && !missing) {
      return { url: row.laststickerImageUrl, source: 'laststicker', fallbackUrl: row.shopImageUrl };
    }
  }
  return row.shopImageUrl === null
    ? null
    : { url: row.shopImageUrl, source: 'shop', fallbackUrl: null };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Card id -> the URL of its chosen reference picture, for the collection's `cardIds`. */
function chosenUrls(
  tx: Tx,
  collection: CollectionId,
  cardIds: readonly CardId[],
  now: number
): Map<CardId, string | null> {
  const out = new Map<CardId, string | null>();
  if (cardIds.length === 0) return out;
  const rows = tx
    .select({ cardId: cards.cardId, ...PICTURE_COLUMNS })
    .from(cards)
    .where(and(eq(cards.collection, collection), inArray(cards.cardId, [...cardIds])))
    .all();
  for (const row of rows) out.set(row.cardId, chooseReference(row, now)?.url ?? null);
  return out;
}

/** The ids whose chosen reference URL differs between two chosenUrls reads, sorted. */
function changedIds(
  before: Map<CardId, string | null>,
  after: Map<CardId, string | null>
): CardId[] {
  return [...after]
    .filter(([id, url]) => before.get(id) !== url)
    .map(([id]) => id)
    .sort(compareCardIds);
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

  /**
   * The catalog name (laststicker's, or the admin's for a manual card) of every named card of the
   * collection, for the eBay title check by name.
   */
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

  /**
   * Record that the card's laststicker scan answered 404 or 410: the shop picture (if usable) is
   * its reference meanwhile.
   */
  markScanMissing(collection: CollectionId, cardId: CardId, now: number): void {
    db.update(cards).set({ laststickerScanMissingAt: now }).where(ofCard(collection, cardId)).run();
  },

  /** The given cards whose scan is recorded missing (any age), sorted. */
  markedScans(collection: CollectionId, cardIds: readonly CardId[]): CardId[] {
    if (cardIds.length === 0) return [];
    return db
      .select({ cardId: cards.cardId })
      .from(cards)
      .where(
        and(
          eq(cards.collection, collection),
          inArray(cards.cardId, [...cardIds]),
          isNotNull(cards.laststickerScanMissingAt)
        )
      )
      .all()
      .map((r) => r.cardId)
      .sort(compareCardIds);
  },

  /**
   * Clear the missing-scan mark of the given cards (their scan loaded again after
   * SCAN_RETRY_MS); returns the ones that had a mark, sorted: their reference changed back.
   */
  clearScanMissing(collection: CollectionId, cardIds: readonly CardId[]): CardId[] {
    if (cardIds.length === 0) return [];
    return db.transaction((tx) => {
      const where = and(
        eq(cards.collection, collection),
        inArray(cards.cardId, [...cardIds]),
        isNotNull(cards.laststickerScanMissingAt)
      );
      const marked = tx.select({ cardId: cards.cardId }).from(cards).where(where).all();
      if (marked.length > 0)
        tx.update(cards).set({ laststickerScanMissingAt: null }).where(where).run();
      return marked.map((r) => r.cardId).sort(compareCardIds);
    });
  },

  /** The card's laststicker scan URL as last synced, or null. */
  laststickerPicture(collection: CollectionId, id: CardId): string | null {
    return (
      db.select({ url: cards.laststickerImageUrl }).from(cards).where(ofCard(collection, id)).get()
        ?.url ?? null
    );
  },

  /**
   * Every card of the collection's catalog, in card order, split into the usable reference
   * pictures and the cards without one. The one accessor for references: each card's picture is
   * chosen by its source (chooseReference: the admin's, laststicker's scan, or the fallback
   * shop's). Without one: no picture yet (`no_picture`), a placeholder file (`_leer.`,
   * `placeholder`), or a picture shown for more than one card (`shared`). The last two tell no
   * card apart, so such a card has no reference (`no_reference`) and is never identified by
   * picture. A picture counts as shared only when several cards of this collection show it.
   */
  referenceCatalog(collection: CollectionId, now: number = Date.now()): ReferenceCatalog {
    const rows = db
      .select({ cardId: cards.cardId, puzzleSeen: cards.puzzleSeen, ...PICTURE_COLUMNS })
      .from(cards)
      .where(eq(cards.collection, collection))
      .all()
      .map((r) => ({ cardId: r.cardId, puzzleSeen: r.puzzleSeen, chosen: chooseReference(r, now) }))
      .sort((a, b) => compareCardIds(a.cardId, b.cardId));
    // A picture counts as shared when several cards show it as their reference or fallback.
    const uses = new Map<string, number>();
    const count = (url: string) => {
      const key = pictureKey(url);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    };
    for (const r of rows) {
      if (r.chosen === null) continue;
      count(r.chosen.url);
      if (r.chosen.fallbackUrl !== null) count(r.chosen.fallbackUrl);
    }
    /** A picture that tells its card apart: no placeholder, not shown for several cards. */
    const distinct = (url: string) =>
      !PLACEHOLDER_FILE.test(pictureKey(url)) && (uses.get(pictureKey(url)) ?? 0) <= 1;
    // A row's collection may have no definition in this build (collectionName).
    const definition: CollectionDefinition | undefined = collectionById(collection);
    const twins = new Set<string>(definition?.knownTwins?.flat() ?? []);
    const usable: ReferenceCard[] = [];
    const missing: MissingReference[] = [];
    for (const { cardId, chosen, puzzleSeen } of rows) {
      if (chosen === null) {
        missing.push({ cardId, reason: 'no_picture' });
      } else if (PLACEHOLDER_FILE.test(pictureKey(chosen.url))) {
        missing.push({ cardId, reason: 'placeholder' });
      } else if ((uses.get(pictureKey(chosen.url)) ?? 0) > 1) {
        missing.push({ cardId, reason: 'shared' });
      } else {
        // The placeholder and shared rules hold for the fallback too.
        const sourced: ChosenSource =
          chosen.source === 'laststicker'
            ? {
                source: 'laststicker',
                fallbackUrl:
                  chosen.fallbackUrl !== null && distinct(chosen.fallbackUrl)
                    ? chosen.fallbackUrl
                    : null,
              }
            : { source: chosen.source, fallbackUrl: null };
        usable.push({
          cardId,
          referenceImageUrl: chosen.url,
          ...sourced,
          puzzle: puzzleSeen,
          ...(twins.has(cardId) ? { knownTwin: true as const } : {}),
        });
      }
    }
    return { usable, missing };
  },

  /**
   * Store the newest picture of catalog cards from the collection's fallback shop
   * (`referenceFallbackShop`, sammel-ente's run), manual cards included; unknown cards are
   * skipped, and an entry without a picture keeps the stored one (a listing that lost its
   * picture must not erase it). Returns the cards whose chosen reference changed
   * (referenceCatalog), so their mismatches are compared again.
   */
  updateShopPictures(
    collection: CollectionId,
    entries: { cardId: CardId; imageUrl: string | null }[],
    now: number = Date.now()
  ): CardId[] {
    const withPicture = entries.filter(
      (e): e is { cardId: CardId; imageUrl: string } => e.imageUrl !== null
    );
    const ids = withPicture.map((e) => e.cardId);
    return db.transaction((tx) => {
      const before = chosenUrls(tx, collection, ids, now);
      for (const e of withPicture) {
        tx.update(cards)
          .set({ shopImageUrl: e.imageUrl, updatedAt: now })
          .where(ofCard(collection, e.cardId))
          .run();
      }
      return changedIds(before, chosenUrls(tx, collection, ids, now));
    });
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
      const before = chosenUrls(
        tx,
        collection,
        rows.map((r) => r.cardId),
        now
      );
      const stored = new Map(
        tx
          .select({
            cardId: cards.cardId,
            name: cards.name,
            source: cards.source,
            listedNotedAt: cards.listedNotedAt,
            laststickerImageUrl: cards.laststickerImageUrl,
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
          // Another scan URL is another picture: whether it loads is not known yet.
          const newScan = before.laststickerImageUrl !== row.pictureUrl;
          tx.update(cards)
            .set({ ...fields, ...(newScan ? { laststickerScanMissingAt: null } : {}) })
            .where(ofCard(collection, row.cardId))
            .run();
        }
      }
      const vanished = [...stored]
        .filter(([cardId, card]) => card.source === 'laststicker' && !listed.has(cardId))
        .map(([cardId]) => cardId);
      if (vanished.length > maxVanished) {
        // Thrown inside the transaction: every write above is rolled back.
        const shown = vanished.sort(compareCardIds).slice(0, 20).join(', ');
        const more = vanished.length > 20 ? ` … and ${vanished.length - 20} more` : '';
        throw new CatalogLayoutError(
          `laststicker: ${vanished.length} stored cards missing from laststicker, more than ${maxVanished}: ${shown}${more}`
        );
      }
      const sorted = (list: CardId[]) => list.sort(compareCardIds);
      const after = chosenUrls(
        tx,
        collection,
        rows.map((r) => r.cardId),
        now
      );
      return {
        added: sorted(added),
        renamed: sorted(renamed),
        vanished: sorted(vanished),
        nowListed: sorted(nowListed),
        repictured: changedIds(before, after).filter((id) => !added.includes(id)),
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
   * laststicker: the admin's picture goes, and the next sync sets its name, kind and scan, which
   * becomes its reference. A card laststicker does not list is refused (`not_listed`): released,
   * it would be reported as vanished every day.
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
        // A laststicker card's reference is its scan: the admin's picture goes.
        .set({
          source: 'laststicker',
          listedNotedAt: null,
          referenceImageUrl: null,
          updatedAt: now,
        })
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

  /** How many of the collection's cards come from laststicker (the ones a sync can miss). */
  laststickerCardCount(collection: CollectionId): number {
    return (
      db
        .select({ n: count() })
        .from(cards)
        .where(and(eq(cards.collection, collection), eq(cards.source, 'laststicker')))
        .get()?.n ?? 0
    );
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
