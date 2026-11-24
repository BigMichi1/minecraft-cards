import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { DiscordAPIError, EmbedBuilder, MessageFlags } from 'discord.js';
import type { ButtonInteraction, MessageCreateOptions } from 'discord.js';
import { eq } from 'drizzle-orm';
import { db, initializeDatabase } from '../database/db';
import { cards, listingCards, listings, reports } from '../database/schema/index';
import { catalogManager } from '../database/catalogManager';
import type { CollectionId } from '../collections/ids';
import { listingManager, type StoredListing } from '../database/listingManager';
import logger from '../utils/logger';
import {
  adminActionRow,
  adminListingEmbed,
  handleAdminConfirm,
  handleAdminDismiss,
  STALE_REPLIES,
  withPictures,
} from './adminActions';
import { encodeConfirmId, encodeDismissId, imageFingerprint } from './buttonIds';
import { cid } from '../../test/cardIds';

const ADMIN = 'admin1';
const REFERENCE = 'https://shop-sammel-ente.de/media/12.png';

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
  return self as unknown as ButtonInteraction & { update: (p: unknown) => Promise<void> };
}

function makeListing(cardIds = [cid('12')]): StoredListing {
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

const confirmId = (l: StoredListing) => encodeConfirmId(l)!;
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
      expect(rowJson(l, true).components.map((c: any) => [c.label, c.custom_id])).toEqual([
        ['✅ Confirm #12', confirmId(l)],
        ['🗑️ Dismiss', encodeDismissId(l.id)],
      ]);
    });

    test('without dismiss only Confirm', () => {
      const l = makeListing();
      expect(rowJson(l, false).components.map((c: any) => c.custom_id)).toEqual([confirmId(l)]);
    });

    test('a bundle is confirmed as a bundle', () => {
      const l = makeListing([cid('12'), cid('13')]);
      expect(rowJson(l, false).components[0]).toMatchObject({
        label: '✅ Confirm bundle',
        custom_id: `admin-confirm:${l.id}:12,13:${imageFingerprint(l.imageUrl)}`,
      });
    });

    test('ids too long for a customId leave only Dismiss, with a warning', () => {
      const warn = spyOn(logger, 'warn');
      try {
        const l = makeListing(Array.from({ length: 40 }, (_, i) => cid(String(i + 100))));
        expect(rowJson(l, true).components.map((c: any) => c.custom_id)).toEqual([
          encodeDismissId(l.id),
        ]);
        expect(warn.mock.calls.some((c) => String(c[0]).includes('Confirm button left out'))).toBe(
          true
        );
      } finally {
        warn.mockRestore();
      }
    });

    test('nothing to show gives null', () => {
      expect(adminActionRow(makeListing([]), { dismiss: false })).toBeNull();
    });
  });

  describe('adminListingEmbed', () => {
    test('shows the lead fields, cards, shop, URL and picture', () => {
      const json = adminListingEmbed(makeListing(), 'Title', [
        { name: 'By', value: 'bob' },
      ]).toJSON();
      expect(json.title).toBe('Title');
      expect(json.fields!.map((f) => f.name)).toEqual(['By', 'Cards', 'Shop', 'URL']);
      expect(json.url).toBe('https://www.ebay.de/itm/1');
      expect(json.image!.url).toBe('https://img/12.jpg');
    });

    test('a usable reference is the thumbnail', () => {
      catalogManager.updateNamesAndReferences('lego-minecraft-3', [
        { cardId: cid('12'), name: 'Squid', imageUrl: REFERENCE },
      ]);
      expect(adminListingEmbed(makeListing(), 't').toJSON().thumbnail!.url).toBe(REFERENCE);
    });

    test("another collection's listing never gets this collection's reference", () => {
      catalogManager.updateNamesAndReferences('lego-minecraft-3', [
        { cardId: cid('12'), name: 'Squid', imageUrl: REFERENCE },
      ]);
      const other = { ...makeListing(), collection: 'other-set' as CollectionId };
      expect(adminListingEmbed(other, 't').toJSON().thumbnail).toBeUndefined();
    });

    test('a placeholder or missing reference is never the thumbnail', () => {
      expect(adminListingEmbed(makeListing(), 't').toJSON().thumbnail).toBeUndefined();
      catalogManager.updateNamesAndReferences('lego-minecraft-3', [
        {
          cardId: cid('12'),
          name: 'Squid',
          imageUrl: 'https://shop-sammel-ente.de/media/12_leer.png',
        },
      ]);
      expect(adminListingEmbed(makeListing(), 't').toJSON().thumbnail).toBeUndefined();
    });
  });

  describe('Confirm', () => {
    test('by the admin confirms, updates the DM and logs it', async () => {
      const info = spyOn(logger, 'info');
      try {
        const l = makeListing();
        await handleAdminConfirm(fakeButton(confirmId(l)), { adminId: ADMIN, now: () => 3000 });
        expect(updates).toEqual([{ content: 'orig\n✅ Confirmed', components: [] }]);
        expect(listingManager.getById(l.id)).toMatchObject({
          matchStatus: 'confirmed',
          manualOverride: true,
          availableSince: 1000,
        });
        expect(
          info.mock.calls.some((c) => String(c[0]).includes(`listing ${l.id} confirmed`))
        ).toBe(true);
      } finally {
        info.mockRestore();
      }
    });

    test('from a DM without text adds only the status line', async () => {
      const l = makeListing();
      await handleAdminConfirm(fakeButton(confirmId(l), ADMIN, ''), { adminId: ADMIN });
      expect(updates).toEqual([{ content: '✅ Confirmed', components: [] }]);
    });

    test('pressed twice stays confirmed and never re-notifies', async () => {
      const l = makeListing();
      await handleAdminConfirm(fakeButton(confirmId(l)), { adminId: ADMIN });
      await handleAdminConfirm(fakeButton(confirmId(l)), { adminId: ADMIN });
      expect(updates).toHaveLength(2);
      expect(listingManager.getById(l.id)!.availableSince).toBe(1000);
    });

    test('by someone else changes nothing', async () => {
      const l = makeListing();
      await handleAdminConfirm(fakeButton(confirmId(l), 'u2'), { adminId: ADMIN });
      expect(replies).toEqual([ephemeralText('Only the admin can do this.')]);
      expect(updates).toEqual([]);
      expect(listingManager.getById(l.id)!.manualOverride).toBe(false);
    });

    test('after the cards changed names the cards', async () => {
      const l = makeListing();
      const stale = `admin-confirm:${l.id}:13:${imageFingerprint(l.imageUrl)}`;
      await handleAdminConfirm(fakeButton(stale), { adminId: ADMIN });
      expect(replies).toEqual([ephemeralText(STALE_REPLIES.cards)]);
      expect(listingManager.getById(l.id)!.manualOverride).toBe(false);
    });

    test('after the picture changed names the picture', async () => {
      const l = makeListing();
      const stale = `admin-confirm:${l.id}:12:${imageFingerprint('https://img/old.jpg')}`;
      const info = spyOn(logger, 'info');
      try {
        await handleAdminConfirm(fakeButton(stale), { adminId: ADMIN });
        expect(
          info.mock.calls.some((c) =>
            String(c[0]).includes(`Confirm of listing ${l.id} refused: picture changed`)
          )
        ).toBe(true);
      } finally {
        info.mockRestore();
      }
      expect(replies).toEqual([ephemeralText(STALE_REPLIES.picture)]);
    });

    test('a listing that became a mismatch or pending names the check', async () => {
      const l = makeListing();
      for (const status of ['mismatch', 'pending'] as const) {
        replies = [];
        db.update(listings).set({ matchStatus: status }).where(eq(listings.id, l.id)).run();
        await handleAdminConfirm(fakeButton(confirmId(l)), { adminId: ADMIN });
        expect(replies).toEqual([ephemeralText(STALE_REPLIES.status)]);
      }
      expect(listingManager.getById(l.id)!.manualOverride).toBe(false);
    });

    test('of a missing listing', async () => {
      await handleAdminConfirm(fakeButton('admin-confirm:999999:12:abc'), { adminId: ADMIN });
      expect(replies).toEqual([ephemeralText('This listing no longer exists.')]);
    });

    test('a malformed id is not valid and is logged', async () => {
      const warn = spyOn(logger, 'warn');
      try {
        for (const id of [
          'admin-confirm:x:12:abc',
          'admin-confirm:1:??:abc',
          'admin-confirm:1:12',
        ]) {
          replies = [];
          await handleAdminConfirm(fakeButton(id), { adminId: ADMIN });
          expect(replies).toEqual([ephemeralText('This button is not valid.')]);
        }
        expect(warn.mock.calls.some((c) => String(c[0]).includes('admin-confirm:x:12:abc'))).toBe(
          true
        );
      } finally {
        warn.mockRestore();
      }
    });

    test('a database failure is reported with the button in the log', async () => {
      const l = makeListing();
      const spy = spyOn(listingManager, 'confirmCards').mockImplementation(() => {
        throw new Error('db down');
      });
      const log = spyOn(logger, 'log');
      try {
        await handleAdminConfirm(fakeButton(confirmId(l)), { adminId: ADMIN });
        expect(replies[0].embeds[0].toJSON().title).toBe('Confirm failed');
        expect(log.mock.calls.some((c) => String(c[1]).includes(confirmId(l)))).toBe(true);
      } finally {
        spy.mockRestore();
        log.mockRestore();
      }
    });

    test('a DM that cannot be updated after confirming says it was confirmed', async () => {
      const l = makeListing();
      const i = fakeButton(confirmId(l));
      i.update = async () => {
        throw new Error('Unknown Message');
      };
      await handleAdminConfirm(i, { adminId: ADMIN });
      expect(replies).toEqual([ephemeralText('Confirmed; this message could not be updated.')]);
      expect(listingManager.getById(l.id)!.manualOverride).toBe(true);
    });

    test('when neither the DM nor a notice can be delivered, the confirmation stands quietly', async () => {
      const l = makeListing();
      const i = fakeButton(confirmId(l));
      i.update = async () => {
        throw new Error('Unknown interaction');
      };
      (i as any).reply = async () => {
        throw new Error('Unknown interaction');
      };
      const log = spyOn(logger, 'log');
      try {
        await handleAdminConfirm(i, { adminId: ADMIN });
        expect(log.mock.calls.some((c) => c[0] === 'error')).toBe(false);
        expect(
          log.mock.calls.some(
            (c) => c[0] === 'warn' && String(c[1]).includes('the admin could not be told')
          )
        ).toBe(true);
      } finally {
        log.mockRestore();
      }
      expect(listingManager.getById(l.id)!.manualOverride).toBe(true);
    });

    test('the status line keeps the DM within 2000 characters', async () => {
      const l = makeListing();
      await handleAdminConfirm(fakeButton(confirmId(l), ADMIN, 'x'.repeat(2000)), {
        adminId: ADMIN,
      });
      expect(updates[0].content.length).toBeLessThanOrEqual(2000);
      expect(updates[0].content).toEndWith('\n✅ Confirmed');
    });
  });

  describe('Dismiss', () => {
    test('lifts the hold, resolves reports and updates the DM', async () => {
      const l = makeListing();
      listingManager.setOnHold(l.id);
      db.insert(reports)
        .values({ listingId: l.id, reporterId: 'r', reason: 'other', createdAt: 1 })
        .run();
      await handleAdminDismiss(fakeButton(encodeDismissId(l.id)), { adminId: ADMIN });
      expect(updates).toEqual([{ content: 'orig\n🗑️ Dismissed', components: [] }]);
      expect(listingManager.getById(l.id)!.onHold).toBe(false);
      expect(db.select().from(reports).get()!.resolvedAt).not.toBeNull();
    });

    test('by someone else changes nothing', async () => {
      const l = makeListing();
      listingManager.setOnHold(l.id);
      await handleAdminDismiss(fakeButton(encodeDismissId(l.id), 'u2'), { adminId: ADMIN });
      expect(replies).toEqual([ephemeralText('Only the admin can do this.')]);
      expect(listingManager.getById(l.id)!.onHold).toBe(true);
    });

    test('of a missing listing', async () => {
      await handleAdminDismiss(fakeButton('admin-dismiss:999999'), { adminId: ADMIN });
      expect(replies).toEqual([ephemeralText('This listing no longer exists.')]);
    });

    test('a malformed id is not valid', async () => {
      for (const id of ['admin-dismiss:x', 'admin-dismiss:1:2']) {
        replies = [];
        await handleAdminDismiss(fakeButton(id), { adminId: ADMIN });
        expect(replies).toEqual([ephemeralText('This button is not valid.')]);
      }
    });

    test('a database failure is reported', async () => {
      const l = makeListing();
      const spy = spyOn(listingManager, 'clearHold').mockImplementation(() => {
        throw new Error('db down');
      });
      try {
        await handleAdminDismiss(fakeButton(encodeDismissId(l.id)), { adminId: ADMIN });
      } finally {
        spy.mockRestore();
      }
      expect(replies[0].embeds[0].toJSON().title).toBe('Dismiss failed');
    });

    test('a DM that cannot be updated after dismissing says it was dismissed', async () => {
      const l = makeListing();
      const i = fakeButton(encodeDismissId(l.id));
      i.update = async () => {
        throw new Error('Unknown Message');
      };
      await handleAdminDismiss(i, { adminId: ADMIN });
      expect(replies).toEqual([ephemeralText('Dismissed; this message could not be updated.')]);
    });
  });

  describe('withPictures', () => {
    const PICTURE = 'https://www.collect-it.de/media/image/product/1/md/14.jpg';
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const message = (): MessageCreateOptions => ({
      embeds: [new EmbedBuilder().setTitle('t').setImage(PICTURE)],
    });
    const download = async () => JPEG;
    const apiError = (status: number, code: number) =>
      new DiscordAPIError(
        { code, message: 'x' },
        code,
        status,
        'POST',
        'https://discord.com/api/channels/1/messages',
        { body: undefined, files: undefined }
      );

    let warn: ReturnType<typeof spyOn>;
    beforeEach(() => {
      warn = spyOn(logger, 'warn');
    });
    afterEach(() => {
      warn.mockRestore();
    });

    test('attaches the listing picture to the admin DM', async () => {
      const sent: MessageCreateOptions[] = [];
      await withPictures(async (m) => void sent.push(m), download)(message());
      expect(sent).toHaveLength(1);
      expect((sent[0]!.files as any[]).map((f) => f.name)).toEqual(['picture-1.jpg']);
      expect((sent[0]!.embeds![0] as any).toJSON().image.url).toBe('attachment://picture-1.jpg');
    });

    test.each([400, 413])(
      'a payload refused with %p is resent once without pictures',
      async (status) => {
        const sent: MessageCreateOptions[] = [];
        let calls = 0;
        await withPictures(async (m) => {
          calls++;
          if (calls === 1) throw apiError(status, 40005);
          sent.push(m);
        }, download)(message());
        expect(calls).toBe(2);
        expect(sent[0]!.files).toBeUndefined();
        expect((sent[0]!.embeds![0] as any).toJSON().image.url).toBe(PICTURE);
      }
    );

    test.each([
      ['closed DMs (50007)', () => apiError(403, 50007)],
      ['a server error', () => apiError(500, 0)],
      ['a timeout', () => new Error('The operation was aborted')],
    ])('%s is raised without a second send', async (_, make) => {
      let calls = 0;
      const error = make();
      const send = withPictures(async () => {
        calls++;
        throw error;
      }, download);
      await expect(send(message())).rejects.toBe(error);
      expect(calls).toBe(1);
    });

    test('the reference thumbnail is attached too', async () => {
      const sent: MessageCreateOptions[] = [];
      const withRef: MessageCreateOptions = {
        embeds: [new EmbedBuilder().setTitle('t').setImage(PICTURE).setThumbnail(REFERENCE)],
      };
      await withPictures(async (m) => void sent.push(m), download)(withRef);
      expect((sent[0]!.files as any[]).map((f) => f.name).sort()).toEqual([
        'picture-1.jpg',
        'reference-1.jpg',
      ]);
    });

    test('the resend warning names the DM', async () => {
      let calls = 0;
      const log = spyOn(logger, 'log');
      try {
        await withPictures(async () => {
          calls++;
          if (calls === 1) throw apiError(413, 40005);
        }, download)({
          embeds: [new EmbedBuilder().setTitle('👍 listing 42').setImage(PICTURE)],
        });
        expect(
          log.mock.calls.some((c) => c[0] === 'warn' && String(c[1]).includes('👍 listing 42'))
        ).toBe(true);
      } finally {
        log.mockRestore();
      }
    });

    test('a DM without attached pictures is sent once as it is', async () => {
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
      const closed = apiError(403, 50007);
      const send = withPictures(async () => {
        calls++;
        throw calls === 1 ? apiError(413, 40005) : closed;
      }, download);
      await expect(send(message())).rejects.toBe(closed);
      expect(calls).toBe(2);
    });
  });
});
