import { and, eq, gte, inArray, isNull, lt, notInArray, or } from 'drizzle-orm';
import { compareCardIds, type CardId } from '../cards/cardId';
import type { MatchStatus, ResolvedMatchStatus } from '../matcher/matchStatus';
import type { ListingFormat, Listing as ShopListing, Money, ShopId } from '../shops/types';
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
        const newCards = existing.manualOverride
          ? storedCards
          : [...new Set(item.cardIds)].sort(compareCardIds);
        const cardsChanged = newCards.join(',') !== storedCards.join(',');
        // An admin-mapped listing stays confirmed: its cards and status are the admin's.
        const rematch =
          !existing.manualOverride &&
          (existing.imageUrl !== item.imageUrl ||
            cardsChanged ||
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

  setMatch(
    listingId: number,
    status: ResolvedMatchStatus,
    similarity: number | null,
    now: number
  ): void {
    db.update(listings)
      .set({ matchStatus: status, similarity, matchCheckedAt: now })
      .where(eq(listings.id, listingId))
      .run();
  },

  /**
   * Available, not on hold, not an ended auction, seen since `seenSince`, sharing a card with
   * the user's list, and not yet notified for this availability period.
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
          onHold: false,
          availableSince: row.available ? now : null,
        })
        .where(eq(listings.id, row.id))
        .run();
      resolveReports(tx, row.id, now);
      return byUrl(tx, url);
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

  /** Listings paused by a report, oldest first. */
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
