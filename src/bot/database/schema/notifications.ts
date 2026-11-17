import { sqliteTable, text, integer, unique } from 'drizzle-orm/sqlite-core';

export const notifications = sqliteTable(
  'notifications',
  {
    discordId: text().notNull(),
    listingId: integer().notNull(),
    availableSince: integer().notNull(),
  },
  (t) => [unique().on(t.discordId, t.listingId, t.availableSince)]
);

export type Notification = typeof notifications.$inferSelect;
