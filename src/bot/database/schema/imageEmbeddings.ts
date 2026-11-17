import { sqliteTable, text, integer, blob } from 'drizzle-orm/sqlite-core';

export const imageEmbeddings = sqliteTable('image_embeddings', {
  imageUrl: text().primaryKey(),
  model: text().notNull(),
  /** Float32 bytes. */
  embedding: blob({ mode: 'buffer' }).notNull(),
  createdAt: integer().notNull(),
});

export type ImageEmbedding = typeof imageEmbeddings.$inferSelect;
