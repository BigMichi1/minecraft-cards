import { and, eq, gte, inArray, isNull, lt, ne, notInArray, or } from 'drizzle-orm';
import { compareCardIds, type CardId } from '../cards/cardId';
import type { MatchResult, MatchStatus } from '../matcher/matchStatus';
import type {
  IdSource,
  ListingFormat,
  Listing as ShopListing,
  Money,
  ShopId,
} from '../shops/types';
import { db } from './db';
import { listingCards, listings, notifications, reports } from './schema/index';
import type { Listing as ListingRow } from './schema/index';
import { userManager } from './userManager';

export type StoredListing = {
  id: number;
  shop: ShopId;
  url: string;
  title: string;
  imageUrl: string | null;
  price: Money | null;
  format: ListingFormat;
  auctionEndsAt: number | null;
  available: boolean;
  availableSince: number | null;
  cardIds: CardId[];
  matchStatus: MatchStatus;
  similarity: number | null;
  /** When the picture was last compared; null before the first comparison. */
  matchCheckedAt: number | null;
  idConflict: boolean;
  onHold: boolean;
  manualOverride: boolean;
  /** When a check last returned this listing. */
  lastSeenAt: number;
  /** `picture`: the title names no card; `cardIds` is the picture's card, or empty. */
  idSource: IdSource;
  /** The card the picture was taken for (see the `pictureCardId` column), or null. */
  pictureCardId: CardId | null;
};

/** One listing to tell a user about: the cards of it they want, for this availability period. */
export interface PendingNotification {
  listing: StoredListing;
  cardIds: CardId[];
  /** The availability period this notification is for (`listing.availableSince`, never null). */
  availableSince: number;
}

/** discordId -> that user's pending notifications, by listing id. */
export type PendingNotifications = Map<string, PendingNotification[]>;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * eBay search results churn: an item can miss one search and be back in the next. A missing
 * eBay listing stays available this long after it was last seen, so it is not re-notified.
 */
export const EBAY_MISSING_GRACE_MS = 24 * 60 * 60 * 1000;

export interface PendingOptions {
  /** Auctions that ended before this are not notified. Defaults to `Date.now()`. */
  now?: number;
  /** Listings last seen before this (a shop that keeps failing) are not notified. */
  seenSince?: number;
  /** Listings left out (their match failed this run, so they were not checked yet). */
  excludeIds?: readonly number[];
}

/**
 * A short, stable fingerprint of a listing picture URL (base 36, at most 13 characters), small
 * enough to travel in a button's customId so a confirmation can tell the picture changed.
 */
export function imageFingerprint(imageUrl: string | null): string {
  return BigInt.asUintN(64, BigInt(Bun.hash(imageUrl ?? ''))).toString(36);
}

function auctionEnded(auctionEndsAt: number | null, now: number): boolean {
  return auctionEndsAt !== null && auctionEndsAt < now;
}

function toStored(row: ListingRow, cardIds: CardId[]): StoredListing {
  return {
    id: row.id,
    shop: row.shop,
    url: row.url,
    title: row.title,
    imageUrl: row.imageUrl,
    price:
      row.priceCents !== null && row.currency !== null
        ? { cents: row.priceCents, currency: row.currency }
        : null,
    format: row.format,
    auctionEndsAt: row.auctionEndsAt,
    available: row.available,
    availableSince: row.availableSince,
    cardIds,
    matchStatus: row.matchStatus,
    similarity: row.similarity,
    matchCheckedAt: row.matchCheckedAt,
    idConflict: row.idConflict,
    onHold: row.onHold,
    manualOverride: row.manualOverride,
    lastSeenAt: row.lastSeenAt,
    idSource: row.idSource,
    pictureCardId: row.pictureCardId,
  };
}

function cardIdsOf(tx: Tx, listingIds: number[]): Map<number, CardId[]> {
  const result = new Map<number, CardId[]>();
  if (listingIds.length === 0) return result;
  const rows = tx
    .select()
    .from(listingCards)
    .where(inArray(listingCards.listingId, listingIds))
    .all();
  for (const { listingId, cardId } of rows) {
    const list = result.get(listingId) ?? [];
    list.push(cardId);
    result.set(listingId, list);
  }
  for (const list of result.values()) list.sort(compareCardIds);
  return result;
}

function load(tx: Tx, rows: ListingRow[]): StoredListing[] {
  const cards = cardIdsOf(
    tx,
    rows.map((r) => r.id)
  );
  return rows.map((r) => toStored(r, cards.get(r.id) ?? []));
}

/** The status of a listing whose picture has not been compared (yet). */
function defaultMatchStatus(shop: ShopId, cardIds: CardId[]): MatchStatus {
  if (shop === 'sammel-ente') return 'reference';
  return cardIds.length > 1 ? 'bundle' : 'pending';
}

function writeCards(tx: Tx, listingId: number, cardIds: CardId[]): void {
  tx.delete(listingCards).where(eq(listingCards.listingId, listingId)).run();
  for (const cardId of new Set(cardIds))
    tx.insert(listingCards).values({ listingId, cardId }).run();
}

function resolveReports(tx: Tx, listingId: number, now: number): void {
  tx.update(reports)
    .set({ resolvedAt: now })
    .where(and(eq(reports.listingId, listingId), isNull(reports.resolvedAt)))
    .run();
}

function byUrl(tx: Tx, url: string): StoredListing | undefined {
  const row = tx.select().from(listings).where(eq(listings.url, url)).get();
  return row ? load(tx, [row])[0] : undefined;
}

export const listingManager = {
  /**
   * Insert or update by url; listings of `shop` missing from `found` become unavailable (eBay:
   * once unseen for EBAY_MISSING_GRACE_MS). Ended auctions are unavailable. Call only after a
   * successful fetch.
   */
  upsertFromRun(shop: ShopId, found: ShopListing[], now: number): StoredListing[] {
    return db.transaction((tx) => {
      const ids: number[] = [];
      for (const scraped of found) {
        const item = auctionEnded(scraped.auctionEndsAt, now)
          ? { ...scraped, available: false }
          : scraped;
        const existing = tx.select().from(listings).where(eq(listings.url, item.url)).get();
        const fields = {
          title: item.title,
          imageUrl: item.imageUrl,
          priceCents: item.price?.cents ?? null,
          currency: item.price?.currency ?? null,
          format: item.format,
          auctionEndsAt: item.auctionEndsAt,
          available: item.available,
          idConflict: item.idConflict,
          idSource: item.idSource ?? 'title',
          lastSeenAt: now,
        };
        if (!existing) {
          const row = tx
            .insert(listings)
            .values({
              ...fields,
              shop: item.shop,
              url: item.url,
              availableSince: item.available ? now : null,
              matchStatus: defaultMatchStatus(item.shop, item.cardIds),
              firstSeenAt: now,
            })
            .returning({ id: listings.id })
            .get();
          writeCards(tx, row.id, item.cardIds);
          ids.push(row.id);
          continue;
        }
        const storedCards = cardIdsOf(tx, [existing.id]).get(existing.id) ?? [];
        // A title naming no card, rescraped unchanged, keeps the card its picture gave it.
        const samePictureOnly =
          fields.idSource === 'picture' &&
          existing.idSource === 'picture' &&
          existing.title === item.title &&
          existing.imageUrl === item.imageUrl;
        const newCards =
          existing.manualOverride || samePictureOnly
            ? storedCards
            : [...new Set(item.cardIds)].sort(compareCardIds);
        const cardsChanged = newCards.join(',') !== storedCards.join(',');
        // An admin-mapped listing stays confirmed: its cards and status are the admin's. A
        // changed title compares again where the picture's card is at stake: a title naming
        // no card, and a mismatch.
        const titleMatters = fields.idSource === 'picture' || existing.matchStatus === 'mismatch';
        const rematch =
          !existing.manualOverride &&
          (existing.imageUrl !== item.imageUrl ||
            cardsChanged ||
            existing.idSource !== fields.idSource ||
            (titleMatters && existing.title !== item.title) ||
            existing.idConflict !== item.idConflict);
        tx.update(listings)
          .set({
            ...fields,
            availableSince: !item.available
              ? null
              : existing.available
                ? existing.availableSince
                : now,
            ...(rematch
              ? {
                  matchStatus: defaultMatchStatus(existing.shop, newCards),
                  similarity: null,
                  matchCheckedAt: null,
                  pictureCardId: null,
                }
              : {}),
          })
          .where(eq(listings.id, existing.id))
          .run();
        if (cardsChanged) writeCards(tx, existing.id, newCards);
        ids.push(existing.id);
      }
      const gone = tx
        .update(listings)
        .set({ available: false, availableSince: null })
        .where(
          and(
            eq(listings.shop, shop),
            eq(listings.available, true),
            ids.length > 0 ? notInArray(listings.id, ids) : undefined,
            shop === 'ebay'
              ? or(
                  lt(listings.lastSeenAt, now - EBAY_MISSING_GRACE_MS),
                  lt(listings.auctionEndsAt, now)
                )
              : undefined
          )
        );
      gone.run();
      return load(
        tx,
        ids.length === 0 ? [] : tx.select().from(listings).where(inArray(listings.id, ids)).all()
      );
    });
  },

  /**
   * Store a comparison. `result.picture` becomes `pictureCardId` (see its column). A listing
   * whose title names no card (`idSource` `picture`) gets exactly the picture's card when
   * confirmed and no card otherwise; an admin-mapped listing keeps the admin's cards. A
   * mismatch is due for its admin note (pendingMismatchNotes).
   */
  setMatch(
    listingId: number,
    result: Pick<MatchResult, 'status' | 'similarity' | 'picture'>,
    now: number
  ): void {
    const pictureCardId = result.picture?.cardId ?? null;
    db.transaction((tx) => {
      const row = tx.select().from(listings).where(eq(listings.id, listingId)).get();
      if (!row) return;
      tx.update(listings)
        .set({
          matchStatus: result.status,
          similarity: result.similarity,
          matchCheckedAt: now,
          pictureCardId,
          mismatchNotedAt: null,
        })
        .where(eq(listings.id, listingId))
        .run();
      if (row.idSource === 'picture' && !row.manualOverride) {
        writeCards(
          tx,
          listingId,
          result.status === 'confirmed' && pictureCardId ? [pictureCardId] : []
        );
      }
    });
  },

  /** Mismatches whose admin note has not gone out yet, oldest first. */
  pendingMismatchNotes(): StoredListing[] {
    return db.transaction((tx) =>
      load(
        tx,
        tx
          .select()
          .from(listings)
          .where(
            and(
              eq(listings.matchStatus, 'mismatch'),
              eq(listings.manualOverride, false),
              isNull(listings.mismatchNotedAt)
            )
          )
          .orderBy(listings.id)
          .all()
      )
    );
  },

  markMismatchNoted(listingId: number, now: number): void {
    db.update(listings).set({ mismatchNotedAt: now }).where(eq(listings.id, listingId)).run();
  },

  /**
   * After the reference pictures of `cardIds` changed: compare again (back to `pending`) every
   * mismatch whose title card or picture card is one of them, and every title naming no card
   * whose picture decided nothing (a fuller reference set may decide it now).
   */
  rematchMismatches(cardIds: CardId[]): void {
    if (cardIds.length === 0) return;
    db.transaction((tx) => {
      tx.update(listings)
        .set({ matchStatus: 'pending', similarity: null, matchCheckedAt: null })
        .where(
          and(
            eq(listings.idSource, 'picture'),
            eq(listings.matchStatus, 'unconfirmed'),
            eq(listings.manualOverride, false)
          )
        )
        .run();
      const byTitle = tx
        .selectDistinct({ id: listingCards.listingId })
        .from(listingCards)
        .where(inArray(listingCards.cardId, cardIds))
        .all()
        .map((r) => r.id);
      tx.update(listings)
        .set({
          matchStatus: 'pending',
          similarity: null,
          matchCheckedAt: null,
          pictureCardId: null,
        })
        .where(
          and(
            eq(listings.matchStatus, 'mismatch'),
            eq(listings.manualOverride, false),
            or(
              inArray(listings.pictureCardId, cardIds),
              byTitle.length > 0 ? inArray(listings.id, byTitle) : undefined
            )
          )
        )
        .run();
    });
  },

  /**
   * Available, not on hold, not a `mismatch` (the picture shows another card), not an ended
   * auction, seen since `seenSince`, sharing a card with the user's list, and not yet notified
   * for this availability period.
   */
  pendingNotifications(options: PendingOptions = {}): PendingNotifications {
    const now = options.now ?? Date.now();
    return db.transaction((tx) => {
      const rows = tx
        .select()
        .from(listings)
        .where(
          and(
            eq(listings.available, true),
            eq(listings.onHold, false),
            ne(listings.matchStatus, 'mismatch'),
            options.excludeIds?.length
              ? notInArray(listings.id, [...options.excludeIds])
              : undefined,
            options.seenSince === undefined
              ? undefined
              : gte(listings.lastSeenAt, options.seenSince)
          )
        )
        .orderBy(listings.id)
        .all();
      const result: PendingNotifications = new Map();
      for (const listing of load(tx, rows)) {
        const { availableSince } = listing;
        if (availableSince === null || auctionEnded(listing.auctionEndsAt, now)) continue;
        for (const [discordId, cardIds] of userManager.usersWanting(listing.cardIds)) {
          const done = tx
            .select()
            .from(notifications)
            .where(
              and(
                eq(notifications.discordId, discordId),
                eq(notifications.listingId, listing.id),
                eq(notifications.availableSince, availableSince)
              )
            )
            .get();
          if (done) continue;
          const list = result.get(discordId) ?? [];
          list.push({ listing, cardIds, availableSince });
          result.set(discordId, list);
        }
      }
      return result;
    });
  },

  recordNotified(discordId: string, listingId: number, availableSince: number): void {
    db.insert(notifications)
      .values({ discordId, listingId, availableSince })
      .onConflictDoNothing()
      .run();
  },

  getByUrl(url: string): StoredListing | undefined {
    return db.transaction((tx) => byUrl(tx, url));
  },

  getById(id: number): StoredListing | undefined {
    return db.transaction((tx) => {
      const row = tx.select().from(listings).where(eq(listings.id, id)).get();
      return row ? load(tx, [row])[0] : undefined;
    });
  },

  /**
   * Manual card mapping: survives rescrapes, counts as confirmed by the admin, lifts the hold,
   * resolves reports, re-opens notification for the new cards.
   */
  overrideCards(url: string, cardIds: CardId[], now: number): StoredListing | undefined {
    return db.transaction((tx) => {
      const row = tx.select().from(listings).where(eq(listings.url, url)).get();
      if (!row) return undefined;
      writeCards(tx, row.id, cardIds);
      tx.update(listings)
        .set({
          manualOverride: true,
          matchStatus: 'confirmed',
          similarity: null,
          pictureCardId: null,
          onHold: false,
          availableSince: row.available ? now : null,
        })
        .where(eq(listings.id, row.id))
        .run();
      resolveReports(tx, row.id, now);
      return byUrl(tx, url);
    });
  },

  /**
   * The admin's one-click confirmation: what `overrideCards` does with the listing's current
   * cards, except that `availableSince` is kept, so users who already had the alert for this
   * availability period are not notified again. `'changed'` (nothing written) when the listing's
   * cards no longer equal `expected`, e.g. a rescrape changed them after the button was sent;
   * when the picture no longer has the fingerprint `expectedImage` the admin saw; and when the
   * listing is a `mismatch` or waits for a comparison (`pending`), as a confirmation is never
   * compared again and would override the picture rule for good.
   */
  confirmCards(
    listingId: number,
    expected: CardId[],
    now: number,
    expectedImage?: string
  ): StoredListing | 'changed' | undefined {
    return db.transaction((tx) => {
      const row = tx.select().from(listings).where(eq(listings.id, listingId)).get();
      if (!row) return undefined;
      if (expectedImage !== undefined && imageFingerprint(row.imageUrl) !== expectedImage) {
        return 'changed';
      }
      if (
        !row.manualOverride &&
        (row.matchStatus === 'mismatch' || row.matchStatus === 'pending')
      ) {
        return 'changed';
      }
      const current = new Set(cardIdsOf(tx, [row.id]).get(row.id) ?? []);
      const wanted = new Set(expected);
      if (current.size !== wanted.size || [...wanted].some((id) => !current.has(id))) {
        return 'changed';
      }
      tx.update(listings)
        .set({
          manualOverride: true,
          matchStatus: 'confirmed',
          similarity: null,
          pictureCardId: null,
          onHold: false,
        })
        .where(eq(listings.id, row.id))
        .run();
      resolveReports(tx, row.id, now);
      return byUrl(tx, row.url);
    });
  },

  clearHold(url: string): StoredListing | undefined {
    return db.transaction((tx) => {
      const row = tx.select().from(listings).where(eq(listings.url, url)).get();
      if (!row) return undefined;
      tx.update(listings).set({ onHold: false }).where(eq(listings.id, row.id)).run();
      resolveReports(tx, row.id, Date.now());
      return byUrl(tx, url);
    });
  },

  /** Every stored listing (any shop, available or not) that carries one of `cardIds`. */
  listingsForCards(cardIds: CardId[]): StoredListing[] {
    if (cardIds.length === 0) return [];
    return db.transaction((tx) => {
      const ids = tx
        .selectDistinct({ id: listingCards.listingId })
        .from(listingCards)
        .where(inArray(listingCards.cardId, cardIds))
        .all()
        .map((r) => r.id);
      if (ids.length === 0) return [];
      return load(
        tx,
        tx.select().from(listings).where(inArray(listings.id, ids)).orderBy(listings.id).all()
      );
    });
  },

  /** Listings paused by a report, oldest first. */
  onHold(): StoredListing[] {
    return db.transaction((tx) =>
      load(
        tx,
        tx.select().from(listings).where(eq(listings.onHold, true)).orderBy(listings.id).all()
      )
    );
  },

  setOnHold(listingId: number): void {
    db.update(listings).set({ onHold: true }).where(eq(listings.id, listingId)).run();
  },
};
