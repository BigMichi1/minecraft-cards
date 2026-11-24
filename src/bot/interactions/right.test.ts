import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, MessageCreateOptions } from 'discord.js';
import { db, initializeDatabase } from '../database/db';
import { adminAlerts, cards, listingCards, listings, reports } from '../database/schema/index';
import { catalogManager } from '../database/catalogManager';
import { imageFingerprint, listingManager, type StoredListing } from '../database/listingManager';
import { handleRightButton } from './right';
import { cid } from '../../test/cardIds';

const DAY = 24 * 60 * 60 * 1000;

let replies: any[] = [];
let deferrals: any[] = [];

function fakeButton(customId: string) {
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

function makeListing(): StoredListing {
  const l = listingManager.upsertFromRun(
    'ebay',
    [
      {
        shop: 'ebay',
        url: 'https://www.ebay.de/itm/1',
        title: 't',
        cardIds: [cid('LE22')],
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
    await handleRightButton(fakeButton(`right:${l.id}`), spy, () => now);
    expect(deferrals).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(lastText()).toBe('Thanks — the admin has been notified.');
    expect(spy.calls).toHaveLength(1);
    const msg = spy.calls[0]!;
    const embed = (msg.embeds![0] as any).toJSON();
    expect(embed.title).toBe(`👍 Card confirmed by a user (listing ${l.id})`);
    expect(embed.fields[0]).toMatchObject({ name: 'By', value: 'bob#1 (u1)' });
    const ids = (msg.components![0] as any).toJSON().components.map((c: any) => c.custom_id);
    expect(ids).toEqual([`admin-confirm:${l.id}:LE22:${imageFingerprint(l.imageUrl)}`]);

    now += DAY - 1;
    await handleRightButton(fakeButton(`right:${l.id}`), spy, () => now);
    expect(lastText()).toBe('Thanks — the admin already has this one.');
    expect(spy.calls).toHaveLength(1);

    now += 1;
    await handleRightButton(fakeButton(`right:${l.id}`), spy, () => now);
    expect(spy.calls).toHaveLength(2);
  });

  test('a listing the admin already confirmed sends nothing', async () => {
    const l = makeListing();
    listingManager.confirmCards(l.id, [cid('LE22')], 2000);
    const spy = adminSpy();
    await handleRightButton(fakeButton(`right:${l.id}`), spy);
    expect(replies).toEqual([
      { content: 'Already confirmed by the admin.', flags: MessageFlags.Ephemeral },
    ]);
    expect(spy.calls).toHaveLength(0);
  });

  test('a missing listing or malformed id', async () => {
    const spy = adminSpy();
    for (const id of ['right:999999', 'right:x', 'right:1:2']) {
      replies = [];
      await handleRightButton(fakeButton(id), spy);
      expect(replies).toEqual([
        { content: 'This listing no longer exists.', flags: MessageFlags.Ephemeral },
      ]);
    }
    expect(spy.calls).toHaveLength(0);
  });

  test('a failed admin DM releases the throttle so the next click retries', async () => {
    const l = makeListing();
    await handleRightButton(fakeButton(`right:${l.id}`), adminSpy(true), () => 5 * DAY);
    expect(lastText()).toBe('The admin could not be reached just now. Please try again later.');
    const spy = adminSpy();
    await handleRightButton(fakeButton(`right:${l.id}`), spy, () => 5 * DAY + 1);
    expect(spy.calls).toHaveLength(1);
    expect(lastText()).toBe('Thanks — the admin has been notified.');
  });

  test('neither holds the listing nor files a report', async () => {
    const l = makeListing();
    await handleRightButton(fakeButton(`right:${l.id}`), adminSpy());
    expect(listingManager.getById(l.id)!.onHold).toBe(false);
    expect(db.select().from(reports).all()).toHaveLength(0);
  });
});
