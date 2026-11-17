import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const adminAlerts = sqliteTable('admin_alerts', {
  key: text().primaryKey(),
  lastSentAt: integer().notNull(),
});

export type AdminAlert = typeof adminAlerts.$inferSelect;
