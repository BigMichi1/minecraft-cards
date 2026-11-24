import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { COLLECTION_IDS } from '../../collections/ids';

/** Per collection: the last laststicker sync attempt, and the last one that succeeded. */
export const catalogSyncs = sqliteTable('catalog_syncs', {
  collection: text({ enum: COLLECTION_IDS }).primaryKey(),
  attemptedAt: integer().notNull(),
  succeededAt: integer(),
});

export type CatalogSync = typeof catalogSyncs.$inferSelect;
