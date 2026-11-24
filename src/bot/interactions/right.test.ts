import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, MessageCreateOptions } from 'discord.js';
import { eq } from 'drizzle-orm';
import { db, initializeDatabase } from '../database/db';
import { adminAlerts, cards, listingCards, listings, reports } from '../database/schema/index';
import { catalogManager } from '../database/catalogManager';
import { listingManager, type StoredListing } from '../database/listingManager';
import { runManager } from '../database/runManager';
import logger from '../utils/logger';
import * as adminActions from './adminActions';
import { encodeConfirmId, imageFingerprint } from './buttonIds';
import { handleRightButton } from './right';
import { cid } from '../../test/cardIds';

const DAY = 24 * 60 * 60 * 1000;

let replies: any[] = [];
let deferrals: any[] = [];

function fakeButton(customId: string, opts: { failEdit?: boolean } = {}) {
  const self = {
    customId,
    user: { id: 'u1', tag: 'bob#1' },
    deferred: false,
    replied: false,
    isChatInputCommand: () => false,
    reply: async (p: unknown) => {
      replies.push(p);
      self.replied = true;
    },
    deferReply: async (p: unknown) => {
      deferrals.push(p);
      self.deferred = true;
    },
    editReply: async (p: unknown) => {
      if (opts.failEdit && replies.length === 0) {
        replies.push('edit failed');
        throw new Error('Unknown interaction');
      }
      replies.push(p);
    },
  };
  return self as unknown as ButtonInteraction;
}

function adminSpy(fail = false) {
  const calls: MessageCreateOptions[] = [];
  const fn = async (m: MessageCreateOptions) => {
    if (fail) throw new Error('DMs closed');
    calls.push(m);
  };
  return Object.assign(fn, { calls });
}

function makeListing(cardIds = [cid('LE22')]): StoredListing {
  const l = listingManager.upsertFromRun(
    'ebay',
    'lego-minecraft-3',
    [
      {
        shop: 'ebay',
        url: 'https://www.ebay.de/itm/1',
        title: 't',
        cardIds,
        cardName: null,
        imageUrl: 'https://img/le22.jpg',
        price: null,
        available: true,
        format: 'fixed_price',
        auctionEndsAt: null,
        idConflict: false,
      },
    ],
    1000
  )[0]!;
  listingManager.setMatch(l.id, { status: 'unconfirmed', similarity: 0.7, picture: null }, 1500);
  return listingManager.getById(l.id)!;
}

const lastText = () => replies[replies.length - 1].content;
const ephemeralText = (content: string) => ({ content, flags: MessageFlags.Ephemeral });

describe('Right button', () => {
  beforeAll(() => {
    initializeDatabase();
  });
  beforeEach(() => {
    replies = [];
    deferrals = [];
    db.delete(adminAlerts).run();
    db.delete(reports).run();
    db.delete(listingCards).run();
    db.delete(listings).run();
    db.delete(cards).run();
    catalogManager.seedIfEmpty();
  });

  test('notifies the admin once a day per listing', async () => {
    const l = makeListing();
    const spy = adminSpy();
    let now = 10 * DAY;
    const deps = { notifyAdmin: spy, now: () => now };
    await handleRightButton(fakeButton(`right:${l.id}`), deps);
    expect(deferrals).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(lastText()).toBe('Thanks — the admin has been notified.');
    expect(spy.calls).toHaveLength(1);
    const msg = spy.calls[0]!;
    expect(msg.content).toBe(
      `Confirm below, or fix with \`/admin map url:${l.url} collection:lego-minecraft-3 cards:LE22\`.`
    );
    const embed = (msg.embeds![0] as any).toJSON();
    expect(embed.title).toBe(`👍 Card confirmed by a user (listing ${l.id})`);
    expect(embed.fields[0]).toMatchObject({ name: 'By', value: 'bob#1 (u1)' });
    const ids = (msg.components![0] as any).toJSON().components.map((c: any) => c.custom_id);
    expect(ids).toEqual([encodeConfirmId(l)]);

    now += DAY - 1;
    await handleRightButton(fakeButton(`right:${l.id}`), deps);
    expect(lastText()).toBe('Thanks — someone already asked the admin about this listing today.');
    expect(spy.calls).toHaveLength(1);

    now += 1;
    await handleRightButton(fakeButton(`right:${l.id}`), deps);
    expect(spy.calls).toHaveLength(2);
  });

  test('a listing too big for a Confirm button is sent without one', async () => {
    const l = makeListing(Array.from({ length: 40 }, (_, i) => cid(String(i + 100))));
    db.update(listings).set({ matchStatus: 'unconfirmed' }).where(eq(listings.id, l.id)).run();
    const spy = adminSpy();
    await handleRightButton(fakeButton(`right:${l.id}`), { notifyAdmin: spy });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.components).toBeUndefined();
    expect(spy.calls[0]!.content).toContain('/admin map url:');
  });

  test('a listing the admin already confirmed sends nothing', async () => {
    const l = makeListing();
    listingManager.confirmCards(
      { listingId: l.id, cardIds: [cid('LE22')], image: imageFingerprint(l.imageUrl) },
      2000
    );
    const spy = adminSpy();
    await handleRightButton(fakeButton(`right:${l.id}`), { notifyAdmin: spy });
    expect(replies).toEqual([ephemeralText('Already confirmed by the admin.')]);
    expect(spy.calls).toHaveLength(0);
  });

  test.each(['confirmed', 'pending', 'mismatch', 'image_unavailable'] as const)(
    'a listing now %p sends nothing',
    async (status) => {
      const l = makeListing();
      db.update(listings).set({ matchStatus: status }).where(eq(listings.id, l.id)).run();
      const spy = adminSpy();
      await handleRightButton(fakeButton(`right:${l.id}`), { notifyAdmin: spy });
      expect(replies).toEqual([
        ephemeralText('This listing changed since the alert; there is nothing to confirm now.'),
      ]);
      expect(spy.calls).toHaveLength(0);
    }
  );

  test('a missing listing', async () => {
    const spy = adminSpy();
    await handleRightButton(fakeButton('right:999999'), { notifyAdmin: spy });
    expect(replies).toEqual([ephemeralText('This listing no longer exists.')]);
    expect(spy.calls).toHaveLength(0);
  });

  test.each(['right:x', 'right:1:2'])('a malformed id %p is not valid', async (id) => {
    const spy = adminSpy();
    await handleRightButton(fakeButton(id), { notifyAdmin: spy });
    expect(replies).toEqual([ephemeralText('This button is not valid.')]);
    expect(spy.calls).toHaveLength(0);
  });

  test('a failed admin DM releases the throttle so the next click retries', async () => {
    const l = makeListing();
    await handleRightButton(fakeButton(`right:${l.id}`), {
      notifyAdmin: adminSpy(true),
      now: () => 5 * DAY,
    });
    expect(lastText()).toBe('The admin could not be reached just now. Please try again later.');
    const spy = adminSpy();
    await handleRightButton(fakeButton(`right:${l.id}`), {
      notifyAdmin: spy,
      now: () => 5 * DAY + 1,
    });
    expect(spy.calls).toHaveLength(1);
    expect(lastText()).toBe('Thanks — the admin has been notified.');
  });

  test('a failed DM on a later day restores the earlier day, so a retry goes out', async () => {
    const l = makeListing();
    const key = `confirm-request:${l.id}`;
    await handleRightButton(fakeButton(`right:${l.id}`), {
      notifyAdmin: adminSpy(),
      now: () => DAY,
    });
    await handleRightButton(fakeButton(`right:${l.id}`), {
      notifyAdmin: adminSpy(true),
      now: () => 3 * DAY,
    });
    expect(runManager.lastAlertAt(key)).toBe(DAY);
    const spy = adminSpy();
    await handleRightButton(fakeButton(`right:${l.id}`), {
      notifyAdmin: spy,
      now: () => 3 * DAY + 1,
    });
    expect(spy.calls).toHaveLength(1);
  });

  test('building the admin DM failing never holds the throttle', async () => {
    const l = makeListing();
    const build = spyOn(adminActions, 'adminActionRow').mockImplementation(() => {
      throw new Error('builder');
    });
    try {
      await handleRightButton(fakeButton(`right:${l.id}`), { notifyAdmin: adminSpy() });
    } finally {
      build.mockRestore();
    }
    expect(runManager.lastAlertAt(`confirm-request:${l.id}`)).toBeUndefined();
  });

  test('a user who cannot be told after the admin was notified is only logged', async () => {
    const l = makeListing();
    const spy = adminSpy();
    const log = spyOn(logger, 'log');
    try {
      await handleRightButton(fakeButton(`right:${l.id}`, { failEdit: true }), {
        notifyAdmin: spy,
      });
      expect(spy.calls).toHaveLength(1);
      expect(log.mock.calls.some((c) => c[0] === 'error')).toBe(false);
      expect(
        log.mock.calls.some(
          (c) => c[0] === 'warn' && String(c[1]).includes('admin notified, but the user')
        )
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
    expect(runManager.lastAlertAt(`confirm-request:${l.id}`)).toBeDefined();
  });

  test('a throttle that cannot be freed still tells the user the admin was not reached', async () => {
    const l = makeListing();
    const release = spyOn(runManager, 'releaseAlert').mockImplementation(() => {
      throw new Error('database is locked');
    });
    try {
      await handleRightButton(fakeButton(`right:${l.id}`), { notifyAdmin: adminSpy(true) });
    } finally {
      release.mockRestore();
    }
    expect(lastText()).toBe('The admin could not be reached just now. Please try again later.');
  });

  test('neither holds the listing nor files a report', async () => {
    const l = makeListing();
    await handleRightButton(fakeButton(`right:${l.id}`), { notifyAdmin: adminSpy() });
    expect(listingManager.getById(l.id)!.onHold).toBe(false);
    expect(db.select().from(reports).all()).toHaveLength(0);
  });
});
