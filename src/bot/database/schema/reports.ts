import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const reports = sqliteTable('reports', {
  id: integer().primaryKey({ autoIncrement: true }),
  listingId: integer().notNull(),
  reporterId: text().notNull(),
  reason: text({ enum: ['wrong_number', 'wrong_series', 'other'] }).notNull(),
  note: text(),
  createdAt: integer().notNull(),
  resolvedAt: integer(),
  /** When the admin DM about this report went out; null when it was not sent or failed. */
  adminNotifiedAt: integer(),
});

export type Report = typeof reports.$inferSelect;
