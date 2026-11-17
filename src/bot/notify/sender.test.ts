import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { db, initializeDatabase } from '../database/db';
import {
  cards,
  listingCards,
  listings,
  notifications,
  users,
  wantedCards,
} from '../database/schema/index';
import { catalogManager } from '../database/catalogManager';
import { listingManager, type StoredListing } from '../database/listingManager';
import { userManager } from '../database/userManager';
import { createDiscordSender } from './sender';

function seedListing(n: number): StoredListing {
  const [stored] = listingManager.upsertFromRun(
    'blue-ocean',
    [
      {
        shop: 'blue-ocean',
        url: `https://shop/${n}`,
        title: `T${n}`,
        cardIds: ['12'],
        cardName: null,
        imageUrl: null,
        price: { cents: 99, currency: 'EUR' },
        available: true,
        format: 'shop',
        auctionEndsAt: null,
        idConflict: false,
      },
    ],
    1000
  );
  if (!stored) throw new Error('listing not stored');
  return stored;
}

function fakeClient(opts: { failFor?: string } = {}) {
  const sent: { user: string; opts: unknown }[] = [];
  return {
    sent,
    users: {
      fetch: async (id: string) => ({
        send: async (o: unknown) => {
          if (id === opts.failFor) throw new Error('Cannot send messages to this user');
          sent.push({ user: id, opts: o });
        },
      }),
    },
  };
}

describe('createDiscordSender', () => {
  beforeAll(() => {
    initializeDatabase();
  });
  beforeEach(() => {
    db.delete(notifications).run();
    db.delete(listingCards).run();
    db.delete(listings).run();
    db.delete(wantedCards).run();
    db.delete(users).run();
    db.delete(cards).run();
    catalogManager.seedIfEmpty();
    userManager.setList('u1', '12');
    userManager.setList('u2', '12');
  });

  test('a failing user is marked and skipped; others are notified and recorded', async () => {
    const l = seedListing(1);
    const client = fakeClient({ failFor: 'u1' });
    const sleeps: number[] = [];
    const sender = createDiscordSender(client, {
      sleep: async (ms) => void sleeps.push(ms),
      now: () => 4242,
    });
    const pending = new Map([
      ['u1', [{ listing: l, cardIds: ['12'] }]],
      ['u2', [{ listing: l, cardIds: ['12'] }]],
    ]);
    expect(await sender.send(pending)).toEqual({ notified: 1, dmFailures: 1 });
    expect(client.sent.map((s) => s.user)).toEqual(['u2']);
    const rows = db.select().from(notifications).all();
    expect(rows.map((r) => r.discordId)).toEqual(['u2']);
    expect(
      db
        .select()
        .from(users)
        .all()
        .find((u) => u.discordId === 'u1')?.dmFailedAt
    ).toBe(4242);
  });

  test('pauses between messages of one user and records each item', async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      listing: seedListing(i + 1),
      cardIds: ['12'],
    }));
    const client = fakeClient();
    const sleeps: number[] = [];
    const sender = createDiscordSender(client, { sleep: async (ms) => void sleeps.push(ms) });
    expect(await sender.send(new Map([['u1', items]]))).toEqual({ notified: 6, dmFailures: 0 });
    expect(client.sent).toHaveLength(2);
    expect(sleeps).toEqual([500]);
    expect(db.select().from(notifications).all()).toHaveLength(6);
  });

  test('a listing with a bad URL does not stop other users', async () => {
    const bad = seedListing(1);
    const good = seedListing(2);
    bad.url = `https://shop/${'x'.repeat(600)}`;
    const client = fakeClient();
    const sender = createDiscordSender(client, { sleep: async () => {} });
    const pending = new Map([
      ['u1', [{ listing: bad, cardIds: ['12'] }]],
      ['u2', [{ listing: good, cardIds: ['12'] }]],
    ]);
    expect(await sender.send(pending)).toEqual({ notified: 2, dmFailures: 0 });
    expect(client.sent.map((s) => s.user)).toEqual(['u1', 'u2']);
  });
});
