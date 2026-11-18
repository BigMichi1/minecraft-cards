import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';
import type { CardId } from '../../cards/cardId';
import { MATCH_STATUSES } from '../../matcher/matchStatus';
import { ID_SOURCES, LISTING_FORMATS, SHOP_IDS } from '../../shops/types';

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
  /** `picture`: the eBay title names no card, its card (if any) is the picture's. */
  idSource: text({ enum: ID_SOURCES }).notNull().default('title'),
  /**
   * Invariant: set exactly when the picture decided the listing's card against the full
   * reference set: the title card (rule 1, `confirmed`), another card (`mismatch`, always set),
   * or the card of a title naming none (`confirmed`). Null for every other status, for an
   * admin-mapped listing, and after a rescrape that asks for a new comparison.
   */
  pictureCardId: text().$type<CardId>(),
  /** When the admin note of the current `mismatch` went out; null while it is due. */
  mismatchNotedAt: integer(),
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
