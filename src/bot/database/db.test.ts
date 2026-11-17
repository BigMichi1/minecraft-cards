/**
 * Smoke test of db.ts and every table in schema/*.ts: the migrations apply to a fresh
 * database and each table takes one row and gives it back. The managers' tests cover the
 * behaviour; this is what covers the schema files themselves.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
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
});
