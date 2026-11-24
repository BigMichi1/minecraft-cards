import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import type { ButtonInteraction, MessageCreateOptions } from 'discord.js';
import { db, initializeDatabase } from '../database/db';
import { cards, listingCards, listings, reports } from '../database/schema/index';
import { catalogManager } from '../database/catalogManager';
import { imageFingerprint, listingManager, type StoredListing } from '../database/listingManager';
import {
  adminActionRow,
  adminListingEmbed,
  handleAdminConfirm,
  handleAdminDismiss,
  withPictures,
} from './adminActions';
import { cid } from '../../test/cardIds';

const ADMIN = 'admin1';

let replies: any[] = [];
let updates: any[] = [];

function fakeButton(customId: string, userId = ADMIN, content = 'orig') {
  const self = {
    customId,
    user: { id: userId, tag: 'x#1' },
    message: { content },
    deferred: false,
    replied: false,
    isChatInputCommand: () => false,
    reply: async (p: unknown) => {
      replies.push(p);
      self.replied = true;
    },
    update: async (p: unknown) => {
      updates.push(p);
    },
    editReply: async (p: unknown) => {
      replies.push(p);
    },
  };
  return self as unknown as ButtonInteraction;
}

function makeListing(cardIds = [cid('12')]): StoredListing {
  const l = listingManager.upsertFromRun(
    'ebay',
    [
      {
        shop: 'ebay',
        url: 'https://www.ebay.de/itm/1',
        title: 't',
        cardIds,
        cardName: null,
        imageUrl: 'https://img/12.jpg',
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

const ephemeralText = (text: string) => ({ content: text, flags: MessageFlags.Ephemeral });
const rowJson = (l: StoredListing, dismiss: boolean) =>
  (adminActionRow(l, { dismiss }) as any)?.toJSON();

describe('admin actions', () => {
  beforeAll(() => {
    initializeDatabase();
  });
  beforeEach(() => {
    replies = [];
    updates = [];
    db.delete(reports).run();
    db.delete(listingCards).run();
    db.delete(listings).run();
    db.delete(cards).run();
    catalogManager.seedIfEmpty();
  });

  describe('adminActionRow', () => {
    test('a single card gets Confirm and Dismiss', () => {
      const l = makeListing();
      const row = rowJson(l, true);
      expect(row.components.map((c: any) => [c.label, c.custom_id])).toEqual([
        ['✅ Confirm #12', `admin-confirm:${l.id}:12:${imageFingerprint(l.imageUrl)}`],
        ['🗑️ Dismiss', `admin-dismiss:${l.id}`],
      ]);
    });

    test('without dismiss only Confirm', () => {
      const l = makeListing();
      expect(rowJson(l, false).components.map((c: any) => c.custom_id)).toEqual([
        `admin-confirm:${l.id}:12:${imageFingerprint(l.imageUrl)}`,
      ]);
    });

    test('a bundle is confirmed as a bundle', () => {
      const l = makeListing([cid('12'), cid('13')]);
      expect(rowJson(l, false).components[0]).toMatchObject({
        label: '✅ Confirm bundle',
        custom_id: `admin-confirm:${l.id}:12,13:${imageFingerprint(l.imageUrl)}`,
      });
    });

    test('ids too long for a customId leave only Dismiss', () => {
      const many = Array.from({ length: 40 }, (_, i) => cid(String(i + 100)));
      const l = makeListing(many);
      expect(rowJson(l, true).components.map((c: any) => c.custom_id)).toEqual([
        `admin-dismiss:${l.id}`,
      ]);
    });

    test('nothing to show gives null', () => {
      const l = makeListing([]);
      expect(adminActionRow(l, { dismiss: false })).toBeNull();
    });
  });

  test('adminListingEmbed shows the cards, shop, URL and picture', () => {
    const l = makeListing();
    const json = adminListingEmbed(l, 'Title', [{ name: 'By', value: 'bob' }]).toJSON();
    expect(json.title).toBe('Title');
    expect(json.fields!.map((f) => f.name)).toEqual(['By', 'Cards', 'Shop', 'URL']);
    expect(json.url).toBe('https://www.ebay.de/itm/1');
    expect(json.image!.url).toBe('https://img/12.jpg');
  });

  describe('Confirm', () => {
    test('by the admin confirms and updates the DM', async () => {
      const l = makeListing();
      await handleAdminConfirm(
        fakeButton(`admin-confirm:${l.id}:12:${imageFingerprint(l.imageUrl)}`),
        { adminId: ADMIN }
      );
      expect(updates).toEqual([{ content: 'orig\n✅ Confirmed', components: [] }]);
      expect(listingManager.getById(l.id)).toMatchObject({
        matchStatus: 'confirmed',
        manualOverride: true,
        availableSince: 1000,
      });
    });

    test('by someone else changes nothing', async () => {
      const l = makeListing();
      await handleAdminConfirm(
        fakeButton(`admin-confirm:${l.id}:12:${imageFingerprint(l.imageUrl)}`, 'u2'),
        { adminId: ADMIN }
      );
      expect(replies).toEqual([ephemeralText('Only the admin can do this.')]);
      expect(updates).toEqual([]);
      expect(listingManager.getById(l.id)!.manualOverride).toBe(false);
    });

    test('after the cards changed is refused', async () => {
      const l = makeListing();
      await handleAdminConfirm(
        fakeButton(`admin-confirm:${l.id}:13:${imageFingerprint(l.imageUrl)}`),
        { adminId: ADMIN }
      );
      expect(replies).toEqual([
        ephemeralText(
          'The listing changed since this message (cards, picture or check); look again or use /admin map.'
        ),
      ]);
      expect(listingManager.getById(l.id)!.manualOverride).toBe(false);
    });

    test('after the picture changed is refused', async () => {
      const l = makeListing();
      const stale = imageFingerprint('https://img/old.jpg');
      await handleAdminConfirm(fakeButton(`admin-confirm:${l.id}:12:${stale}`), {
        adminId: ADMIN,
      });
      expect(replies).toEqual([
        ephemeralText(
          'The listing changed since this message (cards, picture or check); look again or use /admin map.'
        ),
      ]);
      expect(listingManager.getById(l.id)!.manualOverride).toBe(false);
    });

    test('of a missing listing or a malformed id', async () => {
      for (const id of [
        'admin-confirm:999999:12:abc',
        'admin-confirm:x:12:abc',
        'admin-confirm:1:??:abc',
        'admin-confirm:1:12',
      ]) {
        replies = [];
        await handleAdminConfirm(fakeButton(id), { adminId: ADMIN });
        expect(replies).toEqual([ephemeralText('This listing no longer exists.')]);
      }
    });

    test('a failure is reported, not thrown', async () => {
      const l = makeListing();
      const spy = spyOn(listingManager, 'confirmCards').mockImplementation(() => {
        throw new Error('db down');
      });
      try {
        await handleAdminConfirm(
          fakeButton(`admin-confirm:${l.id}:12:${imageFingerprint(l.imageUrl)}`),
          { adminId: ADMIN }
        );
      } finally {
        spy.mockRestore();
      }
      expect(replies[0].embeds[0].toJSON().title).toBe('Confirm failed');
    });

    test('the status line keeps the DM within 2000 characters', async () => {
      const l = makeListing();
      await handleAdminConfirm(
        fakeButton(
          `admin-confirm:${l.id}:12:${imageFingerprint(l.imageUrl)}`,
          ADMIN,
          'x'.repeat(2000)
        ),
        {
          adminId: ADMIN,
        }
      );
      expect(updates[0].content.length).toBeLessThanOrEqual(2000);
      expect(updates[0].content).toEndWith('✅ Confirmed');
    });
  });

  describe('Dismiss', () => {
    test('lifts the hold, resolves reports and updates the DM', async () => {
      const l = makeListing();
      listingManager.setOnHold(l.id);
      db.insert(reports)
        .values({ listingId: l.id, reporterId: 'r', reason: 'other', createdAt: 1 })
        .run();
      await handleAdminDismiss(fakeButton(`admin-dismiss:${l.id}`), { adminId: ADMIN });
      expect(updates).toEqual([{ content: 'orig\n🗑️ Dismissed', components: [] }]);
      expect(listingManager.getById(l.id)!.onHold).toBe(false);
      expect(db.select().from(reports).get()!.resolvedAt).not.toBeNull();
    });

    test('by someone else changes nothing', async () => {
      const l = makeListing();
      listingManager.setOnHold(l.id);
      await handleAdminDismiss(fakeButton(`admin-dismiss:${l.id}`, 'u2'), { adminId: ADMIN });
      expect(replies).toEqual([ephemeralText('Only the admin can do this.')]);
      expect(listingManager.getById(l.id)!.onHold).toBe(true);
    });

    test('of a missing listing', async () => {
      await handleAdminDismiss(fakeButton('admin-dismiss:999999'), { adminId: ADMIN });
      expect(replies).toEqual([ephemeralText('This listing no longer exists.')]);
    });
  });

  describe('withPictures', () => {
    const PICTURE = 'https://www.collect-it.de/media/image/product/1/md/14.jpg';
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const message = (): MessageCreateOptions => ({
      embeds: [new EmbedBuilder().setTitle('t').setImage(PICTURE)],
    });
    const download = async () => JPEG;

    test('attaches the listing picture to the admin DM', async () => {
      const sent: MessageCreateOptions[] = [];
      await withPictures(async (m) => void sent.push(m), download)(message());
      expect(sent).toHaveLength(1);
      expect((sent[0]!.files as any[]).map((f) => f.name)).toEqual(['picture-1.jpg']);
      expect((sent[0]!.embeds![0] as any).toJSON().image.url).toBe('attachment://picture-1.jpg');
    });

    test('a DM refused with pictures is resent once without them', async () => {
      const sent: MessageCreateOptions[] = [];
      let calls = 0;
      await withPictures(async (m) => {
        calls++;
        if (calls === 1) throw new Error('413 Request entity too large');
        sent.push(m);
      }, download)(message());
      expect(calls).toBe(2);
      expect(sent[0]!.files).toBeUndefined();
      expect((sent[0]!.embeds![0] as any).toJSON().image.url).toBe(PICTURE);
    });

    test('a DM that fails without pictures attached is not resent', async () => {
      let calls = 0;
      const send = withPictures(
        async () => {
          calls++;
          throw new Error('DMs closed');
        },
        async () => {
          throw new Error('404');
        }
      );
      await expect(send(message())).rejects.toThrow('DMs closed');
      expect(calls).toBe(1);
    });

    test('the error of the plain resend is the one raised', async () => {
      let calls = 0;
      const send = withPictures(async () => {
        calls++;
        throw new Error(calls === 1 ? 'too large' : 'DMs closed');
      }, download);
      await expect(send(message())).rejects.toThrow('DMs closed');
      expect(calls).toBe(2);
    });
  });
});
