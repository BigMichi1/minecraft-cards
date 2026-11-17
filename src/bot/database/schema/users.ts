import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

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
    cardId: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.discordId, t.cardId] })]
);

export type User = typeof users.$inferSelect;
export type WantedCard = typeof wantedCards.$inferSelect;
