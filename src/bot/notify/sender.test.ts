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
import { DiscordAPIError, HTTPError, RESTJSONErrorCodes } from 'discord.js';
import type { PendingNotification } from '../database/listingManager';
import { createDiscordSender, isDmClosed, isPayloadRejection } from './sender';
import { cid, ids } from '../../test/cardIds';

function seedListing(n: number): StoredListing {
  const [stored] = listingManager.upsertFromRun(
    'blue-ocean',
    'lego-minecraft-3',
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
    /** What a send carrying files throws (before the other failure options). */
    rejectFiles?: () => unknown;
  } = {}
) {
  const sent: { user: string; opts: unknown }[] = [];
  const attempts: { user: string; files: number }[] = [];
  const sends = new Map<string, number>();
  return {
    sent,
    attempts,
    users: {
      fetch: async (id: string) => {
        if (opts.fetchFails) throw new Error('Unknown User');
        return {
          send: async (o: unknown) => {
            const fileCount = (o as { files?: unknown[] }).files?.length ?? 0;
            attempts.push({ user: id, files: fileCount });
            if (opts.rejectFiles && fileCount > 0) throw opts.rejectFiles();
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

function apiError(code: number, status: number): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: `error ${code}` },
    code,
    status,
    'POST',
    'https://discord.com/api/v10/channels/1/messages',
    {}
  );
}

function dmFailedAt(discordId: string): number | null | undefined {
  return db
    .select()
    .from(users)
    .all()
    .find((u) => u.discordId === discordId)?.dmFailedAt;
}

const noAlert = async () => 'sent' as const;

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
    userManager.setList('u1', 'lego-minecraft-3', '12');
    userManager.setList('u2', 'lego-minecraft-3', '12');
  });

  test('a failing user is marked and skipped; others are notified and recorded', async () => {
    const l = seedListing(1);
    const client = fakeClient({ failFor: 'u1' });
    const sleeps: number[] = [];
    const sender = createDiscordSender(client, {
      alert: noAlert,
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
    const sender = createDiscordSender(client, {
      alert: noAlert,
      sleep: async (ms) => void sleeps.push(ms),
    });
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
    const sender = createDiscordSender(client, { alert: noAlert, sleep: async () => {} });
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
    const sender = createDiscordSender(client, { alert: noAlert, sleep: async () => {} });
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
    const sender = createDiscordSender(client, { alert: noAlert, sleep: async () => {} });
    await sender.send(new Map([['u1', items]]));
    expect(client.sent.map((s) => (s.opts as { content?: string }).content)).toEqual(
      Array(5).fill(undefined)
    );
  });

  test('a DM that fails while shutting down does not mark the user', async () => {
    const l = seedListing(1);
    const client = fakeClient({ failAll: true });
    const sender = createDiscordSender(client, {
      alert: noAlert,
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

  describe('listing pictures', () => {
    const picture = 'https://www.collect-it.de/media/image/product/1/md/12.jpg';
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
    type Sent = { files?: { name: string }[]; embeds?: { toJSON?: () => unknown }[] };
    const imageUrlOf = (o: unknown) =>
      (
        ((o as Sent).embeds?.[0] as { toJSON(): { image?: { url: string } } }).toJSON() as {
          image?: { url: string };
        }
      ).image?.url;

    test('a downloaded picture is attached and the embed points at it', async () => {
      const l = { ...seedListing(1), imageUrl: picture };
      const client = fakeClient();
      const downloads: string[] = [];
      const sender = createDiscordSender(client, {
        alert: noAlert,
        sleep: async () => {},
        downloadImage: async (url) => {
          downloads.push(url);
          return JPEG;
        },
      });
      expect(await sender.send(new Map([['u1', [pending(l)]]]))).toEqual({
        notified: 1,
        dmFailures: 0,
      });
      expect(downloads).toEqual([picture]);
      const opts = client.sent[0]?.opts as Sent;
      expect(opts.files?.map((f) => f.name)).toEqual(['picture-1.jpg']);
      expect(imageUrlOf(opts)).toBe('attachment://picture-1.jpg');
    });

    test('a failed download still sends with the URL and records the item', async () => {
      const l = { ...seedListing(1), imageUrl: picture };
      const client = fakeClient();
      const sender = createDiscordSender(client, {
        alert: noAlert,
        sleep: async () => {},
        downloadImage: async () => {
          throw new Error('connection reset');
        },
      });
      expect(await sender.send(new Map([['u1', [pending(l)]]]))).toEqual({
        notified: 1,
        dmFailures: 0,
      });
      const opts = client.sent[0]?.opts as Sent;
      expect(opts.files ?? []).toEqual([]);
      expect(imageUrlOf(opts)).toBe(picture);
      expect(db.select().from(notifications).all()).toHaveLength(1);
    });

    test('closed DMs with a picture still mark the user and record nothing', async () => {
      const l = { ...seedListing(1), imageUrl: picture };
      const client = fakeClient({ failFor: 'u1' });
      const sender = createDiscordSender(client, {
        alert: noAlert,
        sleep: async () => {},
        now: () => 77,
        downloadImage: async () => JPEG,
      });
      expect(await sender.send(new Map([['u1', [pending(l)]]]))).toEqual({
        notified: 0,
        dmFailures: 1,
      });
      expect(dmFailedAt('u1')).toBe(77);
      expect(db.select().from(notifications).all()).toHaveLength(0);
    });
  });

  describe('one message per listing for up to 5 listings', () => {
    test('3 listings are 3 messages, each with its own buttons', async () => {
      const items = Array.from({ length: 3 }, (_, i) => pending(seedListing(i + 1)));
      const client = fakeClient();
      const sender = createDiscordSender(client, { alert: noAlert, sleep: async () => {} });
      expect(await sender.send(new Map([['u1', items]]))).toEqual({ notified: 3, dmFailures: 0 });
      expect(client.sent).toHaveLength(3);
      for (const s of client.sent) {
        const o = s.opts as { embeds: unknown[]; components: unknown[] };
        expect(o.embeds).toHaveLength(1);
        expect(o.components).toHaveLength(1);
      }
    });

    test('closed DMs on message 2 of 3 record only message 1 and stop that user', async () => {
      const items = Array.from({ length: 3 }, (_, i) => pending(seedListing(i + 1)));
      const client = fakeClient({ failOnSend: 2 });
      const sender = createDiscordSender(client, {
        alert: noAlert,
        sleep: async () => {},
        now: () => 4242,
      });
      const batch = new Map([
        ['u1', items],
        ['u2', [items[0]!]],
      ]);
      expect(await sender.send(batch)).toEqual({ notified: 2, dmFailures: 1 });
      expect(client.sent.map((s) => s.user)).toEqual(['u1', 'u2']);
      const recorded = db.select().from(notifications).all();
      expect(recorded.map((r) => [r.discordId, r.listingId])).toEqual([
        ['u1', items[0]!.listing.id],
        ['u2', items[0]!.listing.id],
      ]);
      expect(dmFailedAt('u1')).toBe(4242);
    });

    test('another failure on message 2 of 3 records only message 1 and does not mark the user', async () => {
      const items = Array.from({ length: 3 }, (_, i) => pending(seedListing(i + 1)));
      const client = fakeClient({ failOnSend: 2, error: () => new Error('503') });
      const sender = createDiscordSender(client, { alert: noAlert, sleep: async () => {} });
      expect(await sender.send(new Map([['u1', items]]))).toEqual({ notified: 1, dmFailures: 0 });
      expect(client.sent).toHaveLength(1);
      expect(
        db
          .select()
          .from(notifications)
          .all()
          .map((r) => r.listingId)
      ).toEqual([items[0]!.listing.id]);
      expect(dmFailedAt('u1')).toBeNull();
    });

    test('each message attaches its own picture', async () => {
      const items = Array.from({ length: 2 }, (_, i) => {
        const l = seedListing(i + 1);
        return pending({ ...l, imageUrl: `https://i.ebayimg.com/${i + 1}.jpg` });
      });
      const client = fakeClient();
      const sender = createDiscordSender(client, {
        alert: noAlert,
        sleep: async () => {},
        downloadImage: async () => new Uint8Array([0xff, 0xd8, 0xff, 1]),
      });
      await sender.send(new Map([['u1', items]]));
      expect(
        client.sent.map((s) => (s.opts as { files?: { name: string }[] }).files?.map((f) => f.name))
      ).toEqual([['picture-1.jpg'], ['picture-1.jpg']]);
    });
  });

  describe('pictures Discord rejects', () => {
    const picture = 'https://www.collect-it.de/media/image/product/1/md/12.jpg';
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
    function setup(client: ReturnType<typeof fakeClient>) {
      const alerts: { key: string; text: string }[] = [];
      const sender = createDiscordSender(client, {
        sleep: async () => {},
        alert: async (key, text) => void alerts.push({ key, text }),
        downloadImage: async () => JPEG,
      });
      const l = { ...seedListing(1), imageUrl: picture };
      return { alerts, sender, batch: new Map([['u1', [pending(l)]]]) };
    }

    test('a 50035 rejection is resent without pictures, recorded and alerted', async () => {
      const client = fakeClient({ rejectFiles: () => apiError(50035, 400) });
      const { alerts, sender, batch } = setup(client);
      expect(await sender.send(batch)).toEqual({ notified: 1, dmFailures: 0 });
      expect(client.attempts.map((a) => a.files)).toEqual([1, 0]);
      expect(db.select().from(notifications).all()).toHaveLength(1);
      expect(alerts.map((a) => a.key)).toEqual(['notify-attachment-rejected']);
      expect(alerts[0]?.text).toContain('error 50035');
    });

    test('a 413 rejection is resent without pictures', async () => {
      const client = fakeClient({ rejectFiles: () => apiError(40005, 413) });
      const { sender, batch } = setup(client);
      expect(await sender.send(batch)).toEqual({ notified: 1, dmFailures: 0 });
      expect(client.attempts.map((a) => a.files)).toEqual([1, 0]);
    });

    test('the plain resend failing too records nothing', async () => {
      const client = fakeClient({
        rejectFiles: () => apiError(50035, 400),
        failAll: true,
        error: () => apiError(50035, 400),
      });
      const { alerts, sender, batch } = setup(client);
      expect(await sender.send(batch)).toEqual({ notified: 0, dmFailures: 0 });
      expect(client.attempts.map((a) => a.files)).toEqual([1, 0]);
      expect(db.select().from(notifications).all()).toHaveLength(0);
      expect(dmFailedAt('u1')).toBeNull();
      expect(alerts.map((a) => a.key)).toContain('notify-attachment-rejected');
    });

    test('a 400 after a shutdown that began once the pictures were attached is not resent', async () => {
      let shuttingDown = false;
      const client = fakeClient({
        rejectFiles: () => {
          shuttingDown = true;
          return apiError(50035, 400);
        },
      });
      const alerts: string[] = [];
      const sender = createDiscordSender(client, {
        sleep: async () => {},
        alert: async (key) => void alerts.push(key),
        isShuttingDown: () => shuttingDown,
        downloadImage: async () => JPEG,
      });
      const l = { ...seedListing(1), imageUrl: picture };
      expect(await sender.send(new Map([['u1', [pending(l)]]]))).toEqual({
        notified: 0,
        dmFailures: 0,
      });
      expect(client.attempts.map((a) => a.files)).toEqual([1]);
      expect(db.select().from(notifications).all()).toHaveLength(0);
      expect(dmFailedAt('u1')).toBeNull();
      expect(alerts).not.toContain('notify-attachment-rejected');
    });

    test('a 5xx is not resent without pictures', async () => {
      const client = fakeClient({ rejectFiles: () => apiError(0, 503) });
      const { sender, batch } = setup(client);
      expect(await sender.send(batch)).toEqual({ notified: 0, dmFailures: 0 });
      expect(client.attempts).toHaveLength(1);
      expect(db.select().from(notifications).all()).toHaveLength(0);
    });

    test('a network error is not resent without pictures', async () => {
      const client = fakeClient({ rejectFiles: () => new Error('ECONNRESET') });
      const { sender, batch } = setup(client);
      expect(await sender.send(batch)).toEqual({ notified: 0, dmFailures: 0 });
      expect(client.attempts).toHaveLength(1);
    });

    test('closed DMs with pictures are not resent and mark the user', async () => {
      const client = fakeClient({ rejectFiles: dmClosedError });
      const { sender, batch } = setup(client);
      expect(await sender.send(batch)).toEqual({ notified: 0, dmFailures: 1 });
      expect(client.attempts).toHaveLength(1);
      expect(dmFailedAt('u1')).not.toBeNull();
    });
  });

  describe('picture downloads per run', () => {
    const reference = 'https://shop-sammel-ente.de/media/12.png';
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    test('the reference thumbnail is fetched once across single messages', async () => {
      catalogManager.updateNamesAndReferences('lego-minecraft-3', [
        { cardId: cid('12'), name: 'Squid', imageUrl: reference },
      ]);
      const items = Array.from({ length: 3 }, (_, i) =>
        pending({ ...seedListing(i + 1), matchStatus: 'unconfirmed' })
      );
      const downloads: string[] = [];
      const client = fakeClient();
      const sender = createDiscordSender(client, {
        alert: noAlert,
        sleep: async () => {},
        downloadImage: async (url) => {
          downloads.push(url);
          return PNG;
        },
      });
      await sender.send(new Map([['u1', items]]));
      expect(downloads).toEqual([reference]);
      expect(client.attempts.map((a) => a.files)).toEqual([1, 1, 1]);
    });

    test('a number from the picture attaches the reference beside the listing picture', async () => {
      catalogManager.updateNamesAndReferences('lego-minecraft-3', [
        { cardId: cid('12'), name: 'Squid', imageUrl: reference },
      ]);
      const l: StoredListing = {
        ...seedListing(1),
        shop: 'ebay',
        imageUrl: 'https://i.ebayimg.com/1.jpg',
        matchStatus: 'confirmed',
        idSource: 'picture',
        pictureCardId: cid('12'),
        similarity: 0.91,
      };
      const downloads: string[] = [];
      const client = fakeClient();
      const sender = createDiscordSender(client, {
        alert: noAlert,
        sleep: async () => {},
        downloadImage: async (url) => {
          downloads.push(url);
          return PNG;
        },
      });
      await sender.send(new Map([['u1', [pending(l)]]]));
      expect(downloads.sort()).toEqual(['https://i.ebayimg.com/1.jpg', reference].sort());
      expect(client.attempts.map((a) => a.files)).toEqual([2]);
    });

    test('nothing is downloaded while shutting down', async () => {
      const l = { ...seedListing(1), imageUrl: 'https://i.ebayimg.com/1.jpg' };
      const downloads: string[] = [];
      const client = fakeClient();
      const sender = createDiscordSender(client, {
        alert: noAlert,
        sleep: async () => {},
        isShuttingDown: () => true,
        downloadImage: async (url) => {
          downloads.push(url);
          return PNG;
        },
      });
      await sender.send(new Map([['u1', [pending(l)]]]));
      expect(downloads).toEqual([]);
      expect(client.attempts.map((a) => a.files)).toEqual([0]);
    });

    test('pictures that fall back raise one throttled alert per run naming the host', async () => {
      const items = Array.from({ length: 2 }, (_, i) =>
        pending({
          ...seedListing(i + 1),
          imageUrl: `https://www.collect-it.de/media/${i + 1}.jpg`,
        })
      );
      const alerts: { key: string; text: string }[] = [];
      const sender = createDiscordSender(fakeClient(), {
        sleep: async () => {},
        alert: async (key, text) => void alerts.push({ key, text }),
        downloadImage: async () => {
          throw new Error('HTTP 403');
        },
      });
      expect(await sender.send(new Map([['u1', items]]))).toEqual({ notified: 2, dmFailures: 0 });
      expect(alerts.map((a) => a.key)).toEqual(['notify-pictures']);
      expect(alerts[0]?.text).toContain('www.collect-it.de 2 of 2');
      expect(alerts[0]?.text).toContain('HTTP 403');
    });

    test('no picture alert when the pictures attach', async () => {
      const l = { ...seedListing(1), imageUrl: 'https://i.ebayimg.com/1.jpg' };
      const keys: string[] = [];
      const sender = createDiscordSender(fakeClient(), {
        sleep: async () => {},
        alert: async (key) => void keys.push(key),
        downloadImage: async () => new Uint8Array([0xff, 0xd8, 0xff, 1]),
      });
      await sender.send(new Map([['u1', [pending(l)]]]));
      expect(keys).toEqual([]);
    });
  });

  describe('batched mode', () => {
    test('6 listings are one message of 5 with markers and one of 1', async () => {
      const items = Array.from({ length: 6 }, (_, i) => pending(seedListing(i + 1)));
      const client = fakeClient();
      const sender = createDiscordSender(client, { alert: noAlert, sleep: async () => {} });
      expect(await sender.send(new Map([['u1', items]]))).toEqual({ notified: 6, dmFailures: 0 });
      type Built = { toJSON(): { title?: string; components?: { label?: string }[] } };
      const sent = client.sent.map((s) => s.opts as { embeds: Built[]; components: Built[] });
      expect(sent.map((o) => [o.embeds.length, o.components.length])).toEqual([
        [5, 5],
        [1, 1],
      ]);
      ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'].forEach((marker, n) =>
        expect(sent[0]!.embeds[n]!.toJSON().title).toStartWith(`${marker} `)
      );
      expect(sent[0]!.components[4]!.toJSON().components?.[0]?.label).toStartWith('5️⃣ ');
      expect(sent[1]!.embeds[0]!.toJSON().title).toStartWith('1️⃣ ');
    });

    test('a failure on batched message 3 records only messages 1 and 2', async () => {
      const items = Array.from({ length: 11 }, (_, i) => pending(seedListing(i + 1)));
      const client = fakeClient({ failOnSend: 3, error: () => new Error('503') });
      const sender = createDiscordSender(client, { alert: noAlert, sleep: async () => {} });
      expect(await sender.send(new Map([['u1', items]]))).toEqual({ notified: 10, dmFailures: 0 });
      const recorded = db.select().from(notifications).all();
      expect(recorded.map((r) => r.listingId).sort((a, b) => a - b)).toEqual(
        items.slice(0, 10).map((i) => i.listing.id)
      );
      expect(dmFailedAt('u1')).toBeNull();
    });
  });

  test('isPayloadRejection is true for 400 and 413 except closed DMs', () => {
    expect(isPayloadRejection(apiError(50035, 400))).toBe(true);
    expect(isPayloadRejection(apiError(40005, 413))).toBe(true);
    expect(isPayloadRejection(new HTTPError(413, 'Payload Too Large', 'POST', 'u', {}))).toBe(true);
    expect(isPayloadRejection(dmClosedError())).toBe(false);
    expect(isPayloadRejection(apiError(0, 503))).toBe(false);
    expect(isPayloadRejection(new HTTPError(502, 'Bad Gateway', 'POST', 'u', {}))).toBe(false);
    expect(isPayloadRejection(new Error('400'))).toBe(false);
  });

  test('isDmClosed is true only for Discord error 50007', () => {
    expect(isDmClosed(dmClosedError())).toBe(true);
    expect(isDmClosed(new Error('Cannot send messages to this user'))).toBe(false);
  });

  test('a send failing after the first message keeps the sent items recorded and the rest pending', async () => {
    const items = Array.from({ length: 12 }, (_, i) => pending(seedListing(i + 1)));
    const client = fakeClient({ failOnSend: 2 });
    const sender = createDiscordSender(client, {
      alert: noAlert,
      sleep: async () => {},
      now: () => 4242,
    });
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
      const sender = createDiscordSender(client, { alert: noAlert, sleep: async () => {} });
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
