import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';

export const listings = sqliteTable('listings', {
  id: integer().primaryKey({ autoIncrement: true }),
  shop: text().notNull(),
  url: text().notNull().unique(),
  title: text().notNull(),
  imageUrl: text(),
  priceCents: integer(),
  currency: text(),
  format: text({ enum: ['shop', 'auction', 'fixed_price'] }).notNull(),
  auctionEndsAt: integer(),
  available: integer({ mode: 'boolean' }).notNull(),
  availableSince: integer(),
  matchStatus: text().notNull(),
  similarity: real(),
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
    cardId: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.listingId, t.cardId] })]
);

export type Listing = typeof listings.$inferSelect;
export type ListingCard = typeof listingCards.$inferSelect;
