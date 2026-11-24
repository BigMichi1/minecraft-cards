import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
import { CARD_TYPES, type CardId } from '../../cards/cardId';
import { COLLECTION_IDS } from '../../collections/ids';

export const cards = sqliteTable(
  'cards',
  {
    collection: text({ enum: COLLECTION_IDS }).notNull(),
    cardId: text().$type<CardId>().notNull(),
    type: text({ enum: CARD_TYPES }).notNull(),
    name: text(),
    referenceImageUrl: text(),
    /**
     * Seen as a puzzle card once ("Puzzlekarte" in a sammel-ente name): stays set when the name
     * changes. Reads OR it with the current name, so rows from before it need no backfill.
     */
    puzzleSeen: integer({ mode: 'boolean' }).notNull().default(false),
    updatedAt: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.collection, t.cardId] })]
);

export type Card = typeof cards.$inferSelect;
