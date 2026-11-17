import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { compareCardIds, type CardId } from '../cards/cardId';
import type { MatchStatus } from '../matcher/embedder';
import type { Listing as ShopListing, Money, ShopId } from '../shops/types';
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
  format: 'shop' | 'auction' | 'fixed_price';
  auctionEndsAt: number | null;
  available: boolean;
  availableSince: number | null;
  cardIds: CardId[];
  matchStatus: MatchStatus;
  similarity: number | null;
  onHold: boolean;
  manualOverride: boolean;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function toStored(row: ListingRow, cardIds: CardId[]): StoredListing {
  return {
    id: row.id,
    shop: row.shop as ShopId,
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
    matchStatus: row.matchStatus as MatchStatus,
    similarity: row.similarity,
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

function defaultMatchStatus(shop: ShopId, cardIds: CardId[]): MatchStatus {
  if (shop === 'sammel-ente') return 'reference';
  return cardIds.length > 1 ? 'bundle' : 'unconfirmed';
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
  /** Insert or update by url; listings of `shop` missing from `found` become unavailable. Call only after a successful fetch. */
  upsertFromRun(shop: ShopId, found: ShopListing[], now: number): StoredListing[] {
    return db.transaction((tx) => {
      const ids: number[] = [];
      for (const item of found) {
        const existing = tx.select().from(listings).where(eq(listings.url, item.url)).get();
        const fields = {
          title: item.title,
          imageUrl: item.imageUrl,
          priceCents: item.price?.cents ?? null,
          currency: item.price?.currency ?? null,
          format: item.format,
          auctionEndsAt: item.auctionEndsAt,
          available: item.available,
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
        const rematch =
          existing.imageUrl !== item.imageUrl || (cardsChanged && !existing.manualOverride);
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
                  matchStatus: defaultMatchStatus(existing.shop as ShopId, newCards),
                  similarity: null,
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
            ids.length > 0 ? notInArray(listings.id, ids) : undefined
          )
        );
      gone.run();
      return load(
        tx,
        ids.length === 0 ? [] : tx.select().from(listings).where(inArray(listings.id, ids)).all()
      );
    });
  },

  setMatch(listingId: number, status: MatchStatus, similarity: number | null): void {
    db.update(listings)
      .set({ matchStatus: status, similarity })
      .where(eq(listings.id, listingId))
      .run();
  },

  /** Available, not on hold, sharing a card with the user's list, and not yet notified for this availability period. */
  pendingNotifications(): Map<string, { listing: StoredListing; cardIds: CardId[] }[]> {
    return db.transaction((tx) => {
      const rows = tx
        .select()
        .from(listings)
        .where(and(eq(listings.available, true), eq(listings.onHold, false)))
        .orderBy(listings.id)
        .all();
      const result = new Map<string, { listing: StoredListing; cardIds: CardId[] }[]>();
      for (const listing of load(tx, rows)) {
        if (listing.availableSince === null) continue;
        for (const [discordId, cardIds] of userManager.usersWanting(listing.cardIds)) {
          const done = tx
            .select()
            .from(notifications)
            .where(
              and(
                eq(notifications.discordId, discordId),
                eq(notifications.listingId, listing.id),
                eq(notifications.availableSince, listing.availableSince)
              )
            )
            .get();
          if (done) continue;
          const list = result.get(discordId) ?? [];
          list.push({ listing, cardIds });
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

  /** Manual card mapping: survives rescrapes, lifts the hold, resolves reports, re-opens notification for the new cards. */
  overrideCards(url: string, cardIds: CardId[], now: number): StoredListing | undefined {
    return db.transaction((tx) => {
      const row = tx.select().from(listings).where(eq(listings.url, url)).get();
      if (!row) return undefined;
      writeCards(tx, row.id, cardIds);
      tx.update(listings)
        .set({
          manualOverride: true,
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

  setOnHold(listingId: number): void {
    db.update(listings).set({ onHold: true }).where(eq(listings.id, listingId)).run();
  },
};
