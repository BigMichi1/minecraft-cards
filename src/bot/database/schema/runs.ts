import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const runs = sqliteTable('runs', {
  id: integer().primaryKey({ autoIncrement: true }),
  startedAt: integer().notNull(),
  finishedAt: integer().notNull(),
  /** JSON of RunSummary. */
  summary: text().notNull(),
});

export type Run = typeof runs.$inferSelect;
