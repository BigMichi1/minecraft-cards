import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';
import type { CardId } from '../../cards/cardId';
import { MATCH_STATUSES } from '../../matcher/matchStatus';
import { LISTING_FORMATS, SHOP_IDS } from '../../shops/types';

export const listings = sqliteTable('listings', {
  id: integer().primaryKey({ autoIncrement: true }),
  shop: text({ enum: SHOP_IDS }).notNull(),
  url: text().notNull().unique(),
  title: text().notNull(),
  imageUrl: text(),
  priceCents: integer(),
  currency: text(),
  format: text({ enum: LISTING_FORMATS }).notNull(),
  auctionEndsAt: integer(),
  available: integer({ mode: 'boolean' }).notNull(),
  availableSince: integer(),
  matchStatus: text({ enum: MATCH_STATUSES }).notNull(),
  similarity: real(),
  /** When the picture was last compared (setMatch); paces retries of `image_unavailable`. */
  matchCheckedAt: integer(),
  /** blue-ocean: URL and picture name disagree on the card number (as last scraped). */
  idConflict: integer({ mode: 'boolean' }).notNull().default(false),
  onHold: integer({ mode: 'boolean' }).notNull().default(false),
  manualOverride: integer({ mode: 'boolean' }).notNull().default(false),
  firstSeenAt: integer().notNull(),
  lastSeenAt: integer().notNull(),
});

export const listingCards = sqliteTable(
  'listing_cards',
  {
    listingId: integer()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    cardId: text().$type<CardId>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.listingId, t.cardId] })]
);

export type Listing = typeof listings.$inferSelect;
export type ListingCard = typeof listingCards.$inferSelect;
