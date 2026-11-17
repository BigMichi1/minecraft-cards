import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
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
import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import type { PendingNotification } from '../database/listingManager';
import { createDiscordSender, isDmClosed } from './sender';
import { cid, ids } from '../../test/cardIds';

function seedListing(n: number): StoredListing {
  const [stored] = listingManager.upsertFromRun(
    'blue-ocean',
    [
      {
        shop: 'blue-ocean',
        url: `https://shop/${n}`,
        title: `T${n}`,
        cardIds: [cid('12')],
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

function pending(listing: StoredListing): PendingNotification {
  return { listing, cardIds: ids('12'), availableSince: listing.availableSince! };
}

function dmClosedError(): DiscordAPIError {
  return new DiscordAPIError(
    {
      code: RESTJSONErrorCodes.CannotSendMessagesToThisUser,
      message: 'Cannot send messages to this user',
    },
    RESTJSONErrorCodes.CannotSendMessagesToThisUser,
    403,
    'POST',
    'https://discord.com/api/v10/channels/1/messages',
    {}
  );
}

function fakeClient(
  opts: {
    failFor?: string;
    failAll?: boolean;
    /** What a failing send throws; closed DMs by default. */
    error?: () => unknown;
    /** Fail the n-th send (1-based) of every user. */
    failOnSend?: number;
    fetchFails?: boolean;
  } = {}
) {
  const sent: { user: string; opts: unknown }[] = [];
  const sends = new Map<string, number>();
  return {
    sent,
    users: {
      fetch: async (id: string) => {
        if (opts.fetchFails) throw new Error('Unknown User');
        return {
          send: async (o: unknown) => {
            const n = (sends.get(id) ?? 0) + 1;
            sends.set(id, n);
            if (opts.failAll || id === opts.failFor || n === opts.failOnSend) {
              throw (opts.error ?? dmClosedError)();
            }
            sent.push({ user: id, opts: o });
          },
        };
      },
    },
  };
}

function dmFailedAt(discordId: string): number | null | undefined {
  return db
    .select()
    .from(users)
    .all()
    .find((u) => u.discordId === discordId)?.dmFailedAt;
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
    const batch = new Map([
      ['u1', [pending(l)]],
      ['u2', [pending(l)]],
    ]);
    expect(await sender.send(batch)).toEqual({ notified: 1, dmFailures: 1 });
    expect(client.sent.map((s) => s.user)).toEqual(['u2']);
    const rows = db.select().from(notifications).all();
    expect(rows.map((r) => r.discordId)).toEqual(['u2']);
    expect(dmFailedAt('u1')).toBe(4242);
  });

  test('pauses between messages of one user and records each item', async () => {
    const items = Array.from({ length: 6 }, (_, i) => pending(seedListing(i + 1)));
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
    const batch = new Map([
      ['u1', [pending(bad)]],
      ['u2', [pending(good)]],
    ]);
    expect(await sender.send(batch)).toEqual({ notified: 2, dmFailures: 0 });
    expect(client.sent.map((s) => s.user)).toEqual(['u1', 'u2']);
  });

  test('sends at most 5 messages per user per run and says how many follow', async () => {
    const items = Array.from({ length: 40 }, (_, i) => pending(seedListing(i + 1)));
    const client = fakeClient();
    const sender = createDiscordSender(client, { sleep: async () => {} });
    expect(await sender.send(new Map([['u1', items]]))).toEqual({ notified: 25, dmFailures: 0 });
    expect(client.sent).toHaveLength(5);
    const recorded = db.select().from(notifications).all();
    expect(recorded.map((r) => r.listingId).sort((a, b) => a - b)).toEqual(
      items.slice(0, 25).map((i) => i.listing.id)
    );
    const contents = client.sent.map((s) => (s.opts as { content?: string }).content);
    expect(contents.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined]);
    expect(contents[4]).toBe('…and 15 more listings will follow in the next checks.');
  });

  test('exactly 25 items need no trailer', async () => {
    const items = Array.from({ length: 25 }, (_, i) => pending(seedListing(i + 1)));
    const client = fakeClient();
    const sender = createDiscordSender(client, { sleep: async () => {} });
    await sender.send(new Map([['u1', items]]));
    expect(client.sent.map((s) => (s.opts as { content?: string }).content)).toEqual(
      Array(5).fill(undefined)
    );
  });

  test('a DM that fails while shutting down does not mark the user', async () => {
    const l = seedListing(1);
    const client = fakeClient({ failAll: true });
    const sender = createDiscordSender(client, {
      sleep: async () => {},
      now: () => 4242,
      isShuttingDown: () => true,
    });
    expect(await sender.send(new Map([['u1', [pending(l)]]]))).toEqual({
      notified: 0,
      dmFailures: 0,
    });
    expect(dmFailedAt('u1')).toBeNull();
    expect(db.select().from(notifications).all()).toHaveLength(0);
  });

  test('isDmClosed is true only for Discord error 50007', () => {
    expect(isDmClosed(dmClosedError())).toBe(true);
    expect(isDmClosed(new Error('Cannot send messages to this user'))).toBe(false);
  });

  test('a send failing after the first message keeps the sent items recorded and the rest pending', async () => {
    const items = Array.from({ length: 12 }, (_, i) => pending(seedListing(i + 1)));
    const client = fakeClient({ failOnSend: 2 });
    const sender = createDiscordSender(client, { sleep: async () => {}, now: () => 4242 });
    expect(await sender.send(new Map([['u1', items]]))).toEqual({ notified: 5, dmFailures: 1 });
    const recorded = db.select().from(notifications).all();
    expect(recorded.map((r) => r.listingId).sort((a, b) => a - b)).toEqual(
      items.slice(0, 5).map((i) => i.listing.id)
    );
    expect(dmFailedAt('u1')).toBe(4242);
  });

  test('a send failure other than closed DMs is not a DM failure and does not mark the user', async () => {
    const l = seedListing(1);
    const alerts: string[] = [];
    const client = fakeClient({ failFor: 'u1', error: () => new Error('503 Service Unavailable') });
    const sender = createDiscordSender(client, {
      sleep: async () => {},
      alert: async (key) => void alerts.push(key),
    });
    const batch = new Map([
      ['u1', [pending(l)]],
      ['u2', [pending(l)]],
    ]);
    expect(await sender.send(batch)).toEqual({ notified: 1, dmFailures: 0 });
    expect(dmFailedAt('u1')).toBeNull();
    expect(
      db
        .select()
        .from(notifications)
        .all()
        .map((r) => r.discordId)
    ).toEqual(['u2']);
    expect(alerts).toEqual([]);
  });

  test('users.fetch failing leaves the items pending and alerts when every DM failed', async () => {
    const l = seedListing(1);
    const alerts: string[] = [];
    const sender = createDiscordSender(fakeClient({ fetchFails: true }), {
      sleep: async () => {},
      alert: async (_key, text) => void alerts.push(text),
    });
    expect(await sender.send(new Map([['u1', [pending(l)]]]))).toEqual({
      notified: 0,
      dmFailures: 0,
    });
    expect(db.select().from(notifications).all()).toHaveLength(0);
    expect(dmFailedAt('u1')).toBeNull();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('Unknown User');
  });

  test('every user with closed DMs alerts once; a single one does not', async () => {
    const l = seedListing(1);
    const keys: string[] = [];
    const alert = async (key: string) => void keys.push(key);
    const all = createDiscordSender(fakeClient({ failAll: true }), {
      sleep: async () => {},
      alert,
    });
    await all.send(new Map([['u1', [pending(l)]]]));
    expect(keys).toEqual([]);
    await all.send(
      new Map([
        ['u1', [pending(l)]],
        ['u2', [pending(l)]],
      ])
    );
    expect(keys).toEqual(['dm-all-failed']);
  });

  test('a recording failure after a sent DM is logged and stops that user', async () => {
    const items = Array.from({ length: 6 }, (_, i) => pending(seedListing(i + 1)));
    const client = fakeClient();
    const record = spyOn(listingManager, 'recordNotified').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const error = spyOn(logger, 'log');
    try {
      const sender = createDiscordSender(client, { sleep: async () => {} });
      expect(await sender.send(new Map([['u1', items]]))).toEqual({ notified: 0, dmFailures: 0 });
      expect(client.sent).toHaveLength(1);
      expect(error.mock.calls.some((c) => String(c[1]).includes('database is locked'))).toBe(true);
    } finally {
      record.mockRestore();
      error.mockRestore();
    }
  });

  test('a message that cannot be built is logged with its stack and alerts the admin', async () => {
    const l = seedListing(1);
    const alerts: string[] = [];
    const broken = {
      ...pending(l),
      cardIds: undefined as unknown as PendingNotification['cardIds'],
    };
    const error = spyOn(logger, 'log');
    try {
      const sender = createDiscordSender(fakeClient(), {
        sleep: async () => {},
        alert: async (key) => void alerts.push(key),
      });
      expect(await sender.send(new Map([['u1', [broken]]]))).toEqual({
        notified: 0,
        dmFailures: 0,
      });
      expect(alerts).toEqual(['notify-build-error']);
      const call = (error.mock.calls as unknown[][]).find((c) =>
        String(c[1]).includes('building notifications')
      );
      expect(call?.[2]).toHaveProperty('stack');
    } finally {
      error.mockRestore();
    }
  });
});
