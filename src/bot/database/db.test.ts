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
      .values({ discordId: 'u1', collection: 'lego-minecraft-3', cardId: cid('12') })
      .run();
    db.insert(cards)
      .values({ collection: 'lego-minecraft-3', cardId: cid('12'), type: 'base', updatedAt: 1 })
      .run();
    const { id } = db
      .insert(listings)
      .values({
        collection: 'lego-minecraft-3',
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
    expect(db.select().from(wantedCards).get()).toEqual({
      discordId: 'u1',
      collection: 'lego-minecraft-3',
      cardId: cid('12'),
    });
    expect(db.select().from(cards).get()).toMatchObject({
      collection: 'lego-minecraft-3',
      cardId: '12',
      type: 'base',
    });
    expect(db.select().from(listings).get()).toMatchObject({
      id,
      collection: 'lego-minecraft-3',
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
  test('the collection migration keeps every row under lego-minecraft-3', () => {
    const dir = path.join(process.cwd(), 'src/bot/database/migrations');
    const journal = JSON.parse(readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    const sqlOf = (tag: string) => readFileSync(path.join(dir, `${tag}.sql`), 'utf8');
    const at = journal.entries.findIndex((e) => sqlOf(e.tag).includes('`collection`'));
    expect(at).toBeGreaterThan(0);
    const old = new Database(':memory:');
    old.run('PRAGMA foreign_keys = ON');
    const apply = (tag: string) => {
      for (const statement of sqlOf(tag).split('--> statement-breakpoint')) {
        if (statement.trim()) old.run(statement);
      }
    };
    for (const e of journal.entries.slice(0, at)) apply(e.tag);
    old.run(
      `INSERT INTO cards (card_id, type, name, reference_image_url, updated_at) VALUES ('12', 'base', 'Squid', 'https://s/12.jpg', 1)`
    );
    old.run(`INSERT INTO users (discord_id, created_at) VALUES ('u1', 1)`);
    old.run(`INSERT INTO wanted_cards (discord_id, card_id) VALUES ('u1', '12'), ('u1', 'LE8')`);
    old.run(
      `INSERT INTO listings (shop, url, title, format, available, available_since, match_status, manual_override, picture_card_id, first_seen_at, last_seen_at)
       VALUES ('blue-ocean', 'https://b/12', 't', 'shop', 1, 5, 'mismatch', 1, '45', 1, 1)`
    );
    old.run(`INSERT INTO listing_cards (listing_id, card_id) VALUES (1, '12')`);
    old.run(
      `INSERT INTO notifications (discord_id, listing_id, available_since) VALUES ('u1', 1, 5)`
    );
    apply(journal.entries[at]!.tag);
    expect(
      old.query('SELECT collection, card_id, name, reference_image_url FROM cards').all()
    ).toEqual([
      {
        collection: 'lego-minecraft-3',
        card_id: '12',
        name: 'Squid',
        reference_image_url: 'https://s/12.jpg',
      },
    ]);
    expect(
      old.query('SELECT discord_id, collection, card_id FROM wanted_cards ORDER BY card_id').all()
    ).toEqual([
      { discord_id: 'u1', collection: 'lego-minecraft-3', card_id: '12' },
      { discord_id: 'u1', collection: 'lego-minecraft-3', card_id: 'LE8' },
    ]);
    expect(
      old
        .query(
          'SELECT id, collection, url, manual_override, picture_card_id, match_status FROM listings'
        )
        .all()
    ).toEqual([
      {
        id: 1,
        collection: 'lego-minecraft-3',
        url: 'https://b/12',
        manual_override: 1,
        picture_card_id: '45',
        match_status: 'mismatch',
      },
    ]);
    expect(old.query('SELECT listing_id, card_id FROM listing_cards').all()).toEqual([
      { listing_id: 1, card_id: '12' },
    ]);
    expect(
      old.query('SELECT discord_id, listing_id, available_since FROM notifications').all()
    ).toEqual([{ discord_id: 'u1', listing_id: 1, available_since: 5 }]);
    expect(() =>
      old.run(
        `INSERT INTO cards (collection, card_id, type, updated_at) VALUES ('lego-minecraft-3', '12', 'base', 2)`
      )
    ).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(old.query('PRAGMA foreign_key_check').all()).toEqual([]);
    old.close();
  });
});
