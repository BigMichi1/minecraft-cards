import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const cards = sqliteTable('cards', {
  cardId: text().primaryKey(),
  type: text({ enum: ['base', 'le', 'xxl'] }).notNull(),
  name: text(),
  referenceImageUrl: text(),
  updatedAt: integer().notNull(),
});

export type Card = typeof cards.$inferSelect;
