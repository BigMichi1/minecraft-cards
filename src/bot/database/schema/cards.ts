import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { CARD_TYPES, type CardId } from '../../cards/cardId';

export const cards = sqliteTable('cards', {
  cardId: text().$type<CardId>().primaryKey(),
  type: text({ enum: CARD_TYPES }).notNull(),
  name: text(),
  referenceImageUrl: text(),
  /**
   * Seen as a puzzle card once ("Puzzlekarte" in a sammel-ente name): stays set when the name
   * changes. Reads OR it with the current name, so rows from before it need no backfill.
   */
  puzzleSeen: integer({ mode: 'boolean' }).notNull().default(false),
  updatedAt: integer().notNull(),
});

export type Card = typeof cards.$inferSelect;
