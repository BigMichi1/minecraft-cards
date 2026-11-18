import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { CARD_TYPES, type CardId } from '../../cards/cardId';

export const cards = sqliteTable('cards', {
  cardId: text().$type<CardId>().primaryKey(),
  type: text({ enum: CARD_TYPES }).notNull(),
  name: text(),
  referenceImageUrl: text(),
  /** A puzzle card ("Puzzlekarte" in the sammel-ente name); never identified by picture alone. */
  puzzle: integer({ mode: 'boolean' }).notNull().default(false),
  updatedAt: integer().notNull(),
});

export type Card = typeof cards.$inferSelect;
