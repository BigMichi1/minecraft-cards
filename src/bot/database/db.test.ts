/**
 * Smoke test of db.ts and every table in schema/*.ts: the migrations apply to a fresh
 * database and each table takes one row and gives it back. The managers' tests cover the
 * behaviour; this is what covers the schema files themselves.
 */
import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { cid } from '../../test/cardIds';
import { db, initializeDatabase, sqlite } from './db';
import {
  adminAlerts,
  cards,
  imageEmbeddings,
  listingCards,
  listings,
  notifications,
  reports,
  runs,
  users,
  wantedCards,
} from './schema/index';

describe('database schema', () => {
  beforeAll(() => {
    initializeDatabase();
    for (const t of [
      notifications,
      reports,
      listingCards,
      listings,
      wantedCards,
      users,
      cards,
      runs,
      adminAlerts,
      imageEmbeddings,
    ]) {
      db.delete(t).run();
    }
  });

  test('migrations apply and foreign keys are enforced', () => {
    expect(sqlite.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    // Applying again is a no-op.
    initializeDatabase();
  });

  test('every table takes a row and returns it', () => {
    db.insert(users).values({ discordId: 'u1', createdAt: 1 }).run();
    db.insert(wantedCards)
      .values({ discordId: 'u1', cardId: cid('12') })
      .run();
    db.insert(cards)
      .values({ cardId: cid('12'), type: 'base', updatedAt: 1 })
      .run();
    const { id } = db
      .insert(listings)
      .values({
        shop: 'blue-ocean',
        url: 'https://www.blue-ocean.de/p/12',
        title: 't',
        format: 'shop',
        available: true,
        matchStatus: 'pending',
        firstSeenAt: 1,
        lastSeenAt: 1,
      })
      .returning({ id: listings.id })
      .get();
    db.insert(listingCards)
      .values({ listingId: id, cardId: cid('12') })
      .run();
    db.insert(notifications).values({ discordId: 'u1', listingId: id, availableSince: 1 }).run();
    db.insert(reports)
      .values({ listingId: id, reporterId: 'u1', reason: 'other', createdAt: 1 })
      .run();
    db.insert(runs).values({ startedAt: 1, finishedAt: 2, summary: '{}' }).run();
    db.insert(adminAlerts).values({ key: 'k', lastSentAt: 1 }).run();
    db.insert(imageEmbeddings)
      .values({ imageUrl: 'https://i', model: 'm', embedding: Buffer.alloc(8), createdAt: 1 })
      .run();

    expect(db.select().from(users).get()).toEqual({
      discordId: 'u1',
      createdAt: 1,
      dmFailedAt: null,
    });
    expect(db.select().from(wantedCards).get()).toEqual({ discordId: 'u1', cardId: cid('12') });
    expect(db.select().from(cards).get()).toMatchObject({ cardId: '12', type: 'base' });
    expect(db.select().from(listings).get()).toMatchObject({
      id,
      onHold: false,
      manualOverride: false,
      idConflict: false,
      matchCheckedAt: null,
      availableSince: null,
    });
    expect(db.select().from(listingCards).get()).toEqual({ listingId: id, cardId: cid('12') });
    expect(db.select().from(notifications).get()).toEqual({
      discordId: 'u1',
      listingId: id,
      availableSince: 1,
    });
    expect(db.select().from(reports).get()).toMatchObject({ listingId: id, adminNotifiedAt: null });
    expect(db.select().from(runs).get()).toMatchObject({ summary: '{}' });
    expect(db.select().from(adminAlerts).get()).toEqual({ key: 'k', lastSentAt: 1 });
    expect(db.select().from(imageEmbeddings).get()!.embedding.byteLength).toBe(8);
  });

  test('deleting a user or listing cascades to its wanted cards and card links', () => {
    db.delete(users).where(eq(users.discordId, 'u1')).run();
    expect(db.select().from(wantedCards).all()).toEqual([]);
    db.delete(notifications).run();
    db.delete(reports).run();
    db.delete(listings).run();
    expect(db.select().from(listingCards).all()).toEqual([]);
  });

  test('a card link to a missing listing is refused', () => {
    expect(() =>
      db
        .insert(listingCards)
        .values({ listingId: 999_999, cardId: cid('1') })
        .run()
    ).toThrow(/FOREIGN KEY/);
  });
  test('the picture-identification migration on rows stored before it (T3, R14)', () => {
    // Apply every migration before the one adding `id_source`, store rows as the old release
    // did, then apply it.
    const dir = path.join(process.cwd(), 'src/bot/database/migrations');
    const journal = JSON.parse(readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    const sqlOf = (tag: string) => readFileSync(path.join(dir, `${tag}.sql`), 'utf8');
    const at = journal.entries.findIndex((e) => sqlOf(e.tag).includes('`id_source`'));
    expect(at).toBeGreaterThan(0);
    const old = new Database(':memory:');
    const apply = (tag: string) => {
      for (const statement of sqlOf(tag).split('--> statement-breakpoint')) {
        if (statement.trim()) old.run(statement);
      }
    };
    for (const e of journal.entries.slice(0, at)) apply(e.tag);
    const listing = (url: string, shop: string, status: string, manual = 0) =>
      old.run(
        `INSERT INTO listings (shop, url, title, format, available, match_status, similarity, manual_override, first_seen_at, last_seen_at)
         VALUES (?, ?, 't', 'shop', 1, ?, 0.9, ?, 1, 1)`,
        [shop, url, status, manual]
      );
    listing('https://b/confirmed', 'blue-ocean', 'confirmed');
    listing('https://b/unconfirmed', 'blue-ocean', 'unconfirmed');
    listing('https://b/mapped', 'blue-ocean', 'confirmed', 1);
    listing('https://e/bundle', 'ebay', 'bundle');
    listing('https://s/ref', 'sammel-ente', 'reference');
    apply(journal.entries[at]!.tag);
    const rows = old
      .query(
        'SELECT url, match_status, similarity, id_source, picture_card_id, mismatch_noted_at FROM listings ORDER BY id'
      )
      .all();
    const plain = { id_source: 'title', picture_card_id: null, mismatch_noted_at: null };
    expect(rows).toEqual([
      // Every compared listing goes through the new rules on the next run.
      { url: 'https://b/confirmed', match_status: 'pending', similarity: null, ...plain },
      { url: 'https://b/unconfirmed', match_status: 'pending', similarity: null, ...plain },
      // The admin's mapping, bundles and references stay.
      { url: 'https://b/mapped', match_status: 'confirmed', similarity: 0.9, ...plain },
      { url: 'https://e/bundle', match_status: 'bundle', similarity: 0.9, ...plain },
      { url: 'https://s/ref', match_status: 'reference', similarity: 0.9, ...plain },
    ]);
    old.close();
  });
});
