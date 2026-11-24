import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
import { CARD_TYPES, type CardId } from '../../cards/cardId';
import { CARD_SOURCES, COLLECTION_IDS } from '../../collections/ids';

export const cards = sqliteTable(
  'cards',
  {
    collection: text({ enum: COLLECTION_IDS }).notNull(),
    cardId: text().$type<CardId>().notNull(),
    type: text({ enum: CARD_TYPES }).notNull(),
    name: text(),
    referenceImageUrl: text(),
    /** laststicker's section (`Characterkarten`, `Puzzlekarten`, ...); null before a sync and for manual cards. */
    kind: text(),
    /** laststicker's type (`Basis Karte`, `Lava Karte`, ...); null before a sync and for manual cards. */
    variant: text(),
    /** `manual` cards are the admin's: the laststicker sync never changes them. */
    source: text({ enum: CARD_SOURCES }).notNull().default('laststicker'),
    /** The card's laststicker scan (404 when laststicker has none); not the reference picture yet. */
    laststickerImageUrl: text(),
    /**
     * A manual card laststicker lists too: when the admin's alert about it was delivered; null
     * while not (the sync reports it again). Cleared only by releaseManual.
     */
    listedNotedAt: integer(),
    /**
     * A puzzle card (laststicker's section `Puzzlekarten`, or once "Puzzlekarte" in a
     * sammel-ente name, migration 0006): never cleared, so a rename cannot drop the mark.
     */
    puzzleSeen: integer({ mode: 'boolean' }).notNull().default(false),
    updatedAt: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.collection, t.cardId] })]
);

export type Card = typeof cards.$inferSelect;
