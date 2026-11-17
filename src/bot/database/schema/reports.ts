import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const reports = sqliteTable('reports', {
  id: integer().primaryKey({ autoIncrement: true }),
  listingId: integer().notNull(),
  reporterId: text().notNull(),
  reason: text({ enum: ['wrong_number', 'wrong_series', 'other'] }).notNull(),
  note: text(),
  createdAt: integer().notNull(),
  resolvedAt: integer(),
});

export type Report = typeof reports.$inferSelect;
