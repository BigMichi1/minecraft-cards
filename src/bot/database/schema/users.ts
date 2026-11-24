import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
import type { CardId } from '../../cards/cardId';
import { COLLECTION_IDS, type CollectionId } from '../../collections/ids';

export const users = sqliteTable('users', {
  discordId: text().primaryKey(),
  createdAt: integer().notNull(),
  dmFailedAt: integer(),
});

export const wantedCards = sqliteTable(
  'wanted_cards',
  {
    discordId: text()
      .notNull()
      .references(() => users.discordId, { onDelete: 'cascade' }),
    collection: text({ enum: COLLECTION_IDS }).$type<CollectionId>().notNull(),
    cardId: text().$type<CardId>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.discordId, t.collection, t.cardId] })]
);

export type User = typeof users.$inferSelect;
export type WantedCard = typeof wantedCards.$inferSelect;
