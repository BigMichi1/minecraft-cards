import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ButtonStyle } from 'discord.js';
import type { MessageCreateOptions } from 'discord.js';
import { db, initializeDatabase } from '../database/db';
import { cards } from '../database/schema/index';
import { catalogManager } from '../database/catalogManager';
import type { CollectionId } from '../collections/ids';
import type { StoredListing } from '../database/listingManager';
import {
  buildNotificationMessages,
  kleinanzeigenSearchUrl,
  SHOP_NAMES,
  SINGLE_MESSAGE_LIMIT,
} from './messages';
import { cid } from '../../test/cardIds';
import { setCatalogCards } from '../../test/catalog';

const referenceUrl = 'https://ref/12.jpg';

function listing(i: number, over: Partial<StoredListing> = {}): StoredListing {
  return {
    id: i,
    collection: 'lego-minecraft-3',
    shop: 'blue-ocean',
    url: `https://shop/${i}`,
    title: `Title ${i}`,
    imageUrl: `https://img/${i}.jpg`,
    price: { cents: 99, currency: 'EUR' },
    format: 'shop',
    auctionEndsAt: null,
    available: true,
    availableSince: 1,
    cardIds: [cid('12')],
    matchStatus: 'confirmed',
    similarity: 0.94,
    matchCheckedAt: null,
    idConflict: false,
    onHold: false,
    manualOverride: false,
    lastSeenAt: 1,
    idSource: 'title',
    pictureCardId: null,
    rematchFrom: null,
    ...over,
  };
}

function item(i: number, over: Partial<StoredListing> = {}) {
  const l = listing(i, over);
  return { listing: l, cardIds: l.cardIds };
}

function embedJson(msg: MessageCreateOptions, idx = 0): any {
  const e = msg.embeds![idx] as any;
  return e.toJSON ? e.toJSON() : e;
}

function atMsg(list: { message: MessageCreateOptions }[], i: number): MessageCreateOptions {
  return at(list, i).message;
}

function at<T>(list: T[], i: number): T {
  const v = list[i];
  if (v === undefined) throw new Error(`no element ${i}`);
  return v;
}

describe('SHOP_NAMES', () => {
  test('names every shop', () => {
    expect(SHOP_NAMES).toEqual({
      'sammel-ente': 'sammel-ente',
      'blue-ocean': 'blue-ocean',
      'collect-it': 'collect-it',
      ebay: 'eBay',
    });
  });
});

describe('notification messages', () => {
  beforeAll(() => {
    initializeDatabase();
  });
  beforeEach(() => {
    db.delete(cards).run();
    catalogManager.seedIfEmpty();
    setCatalogCards('lego-minecraft-3', [
      { cardId: cid('12'), name: 'Squid', imageUrl: referenceUrl },
    ]);
  });

  test('kleinanzeigenSearchUrl lowercases the id', () => {
    expect(kleinanzeigenSearchUrl(cid('LE8'))).toBe(
      'https://www.kleinanzeigen.de/s-lego-minecraft-karte-le8/k0'
    );
  });

  test('up to 5 listings get one message each, buttons in the same message, no markers', () => {
    expect(SINGLE_MESSAGE_LIMIT).toBe(5);
    for (const count of [1, 5]) {
      const msgs = buildNotificationMessages(Array.from({ length: count }, (_, i) => item(i + 1)));
      expect(msgs).toHaveLength(count);
      msgs.forEach((m, i) => {
        expect(m.items.map((x) => x.listing.id)).toEqual([i + 1]);
        expect(m.message.embeds).toHaveLength(1);
        expect(m.message.components).toHaveLength(1);
        expect(embedJson(m.message).title).toBe('🟢 Card #12 Squid is available');
        const row = (m.message.components![0] as any).toJSON();
        expect(row.components.map((c: { label: string }) => c.label)).toEqual([
          '#12 · blue-ocean',
          'Kleinanzeigen #12',
          '❌ Wrong #12',
        ]);
        expect(row.components[0].url).toBe(`https://shop/${i + 1}`);
        expect(row.components[2].custom_id).toBe(`report:${i + 1}`);
      });
    }
  });

  test('6 listings switch to batches of 5 with position markers', () => {
    const msgs = buildNotificationMessages(Array.from({ length: 6 }, (_, i) => item(i + 1)));
    expect(msgs.map((m) => m.items.length)).toEqual([5, 1]);
    expect(embedJson(at(msgs, 1).message, 0).title).toStartWith('1️⃣ ');
  });

  test('batches 5 items per message with link and report buttons', () => {
    const msgs = buildNotificationMessages(Array.from({ length: 7 }, (_, i) => item(i + 1)));
    expect(msgs).toHaveLength(2);
    expect(at(msgs, 0).message.embeds).toHaveLength(5);
    expect(at(msgs, 0).message.components).toHaveLength(5);
    expect(at(msgs, 1).message.embeds).toHaveLength(2);
    const row = (at(msgs, 0).message.components![0] as any).toJSON();
    expect(row.components.map((c: { label: string }) => c.label)).toEqual([
      '1️⃣ #12 · blue-ocean',
      'Kleinanzeigen #12',
      '❌ Wrong #12',
    ]);
    const fifth = (at(msgs, 0).message.components![4] as any).toJSON();
    expect(fifth.components[0].label).toBe('5️⃣ #12 · blue-ocean');
    expect(embedJson(at(msgs, 0).message, 4).title).toStartWith('5️⃣ ');
    // Numbering restarts with every message.
    expect(embedJson(at(msgs, 1).message, 0).title).toStartWith('1️⃣ ');
    expect(row.components[0].url).toBe('https://shop/1');
    expect(row.components[1].url).toBe('https://www.kleinanzeigen.de/s-lego-minecraft-karte-12/k0');
    expect(row.components[2].custom_id).toBe('report:1');
  });

  test('embed title, fields, image and confirmed footer', () => {
    const e = embedJson(atMsg(buildNotificationMessages([item(1)]), 0));
    expect(e.title).toBe('🟢 Card #12 Squid is available');
    expect(e.image.url).toBe('https://img/1.jpg');
    expect(e.thumbnail).toBeUndefined();
    expect(e.footer.text).toBe('✅ picture matches reference (0.94)');
    const values = e.fields.map((f: { value: string }) => f.value).join('|');
    expect(values).toContain('blue-ocean');
    expect(values).toContain('0,99 €');
  });

  test('unknown name, unconfirmed footer with reference thumbnail', () => {
    const msgs = buildNotificationMessages([
      item(1, { cardIds: [cid('45')], matchStatus: 'unconfirmed', similarity: 0.5 }),
      item(2, { matchStatus: 'unconfirmed', similarity: 0.5 }),
    ]);
    expect(embedJson(at(msgs, 0).message).title).toBe('🟢 Card #45 is available');
    const e = embedJson(at(msgs, 1).message);
    expect(e.footer.text).toContain('⚠️ number unconfirmed');
    expect(e.thumbnail.url).toBe(referenceUrl);
  });

  test('footers for other statuses; reference has none; null image and null reference', () => {
    const f = (over: Partial<StoredListing>) =>
      embedJson(atMsg(buildNotificationMessages([item(1, over)]), 0));
    expect(
      f({ matchStatus: 'bundle', cardIds: [cid('12'), cid('45')], shop: 'ebay' }).footer.text
    ).toBe('ℹ️ bundle — check the listing');
    expect(f({ matchStatus: 'no_reference' }).footer.text).toBe('ℹ️ no reference picture yet');
    expect(f({ matchStatus: 'pending' }).footer.text).toBe('ℹ️ picture not checked yet');
    expect(f({ matchStatus: 'image_unavailable' }).footer.text).toBe(
      'ℹ️ picture could not be loaded'
    );
    expect(f({ matchStatus: 'model_unavailable' }).footer.text).toBe(
      'ℹ️ picture check unavailable'
    );
    const ente = f({ matchStatus: 'confirmed', similarity: 0.95, shop: 'sammel-ente' });
    expect(ente.footer.text).toBe('✅ picture matches reference (0.95)');
    expect(ente.fields.map((x: { value: string }) => x.value).join('|')).toContain('sammel-ente');
    expect(f({ imageUrl: null }).image).toBeUndefined();
    const noRef = f({ matchStatus: 'unconfirmed', cardIds: [cid('45')] });
    expect(noRef.thumbnail).toBeUndefined();
  });

  test('bundle title and eBay auction price', () => {
    const e = embedJson(
      atMsg(
        buildNotificationMessages([
          item(1, {
            shop: 'ebay',
            cardIds: [cid('12'), cid('45')],
            matchStatus: 'bundle',
            format: 'auction',
            auctionEndsAt: 1_700_000_000_000,
            price: { cents: 1250, currency: 'EUR' },
          }),
        ]),
        0
      )
    );
    expect(e.title).toBe('🟢 Bundle with #12, #45 on eBay');
    const price = e.fields.find((x: { name: string }) => x.name === 'Price').value;
    expect(price).toBe('12,50 € · Auction · ends <t:1700000000:R>');
  });

  test('non-EUR price and long titles stay within Discord limits', () => {
    const ids = Array.from({ length: 200 }, (_, i) => cid(String(i + 1)));
    const e = embedJson(
      atMsg(
        buildNotificationMessages([
          item(1, {
            cardIds: ids,
            shop: 'ebay',
            matchStatus: 'bundle',
            price: { cents: 500, currency: 'USD' },
          }),
        ]),
        0
      )
    );
    expect(e.title.length).toBeLessThanOrEqual(256);
    const row = (
      atMsg(buildNotificationMessages([item(1, { cardIds: ids, shop: 'ebay' })]), 0)
        .components![0] as any
    ).toJSON();
    expect(row.components.map((c: { label: string }) => c.label)).toEqual([
      'Bundle · eBay',
      'Kleinanzeigen #1',
      '❌ Wrong bundle',
    ]);
    for (const c of row.components) expect(c.label.length).toBeLessThanOrEqual(80);
    expect(e.fields.find((x: { name: string }) => x.name === 'Price').value).toBe('5.00 USD');
  });

  test('invalid URLs never throw: no shop button, no image, report button stays', () => {
    const long = `https://shop/${'x'.repeat(600)}`;
    const msgs = buildNotificationMessages([
      item(1, { url: long }),
      item(2, { imageUrl: 'not a url' }),
      item(3, { url: 'ftp://shop/3' }),
    ]);
    const labels = (i: number) =>
      (atMsg(msgs, i).components![0] as any)
        .toJSON()
        .components.map((c: { label: string }) => c.label);
    expect(labels(0)).toEqual(['Kleinanzeigen #12', '❌ Wrong #12']);
    expect(embedJson(atMsg(msgs, 0)).url).toBeUndefined();
    expect(embedJson(atMsg(msgs, 1)).image).toBeUndefined();
    expect(labels(1)).toContain('#12 · blue-ocean');
    expect(labels(2)).toEqual(['Kleinanzeigen #12', '❌ Wrong #12']);
    expect(msgs.map((m) => m.items.map((x) => x.listing.id))).toEqual([[1], [2], [3]]);
  });

  test('a card number from the picture says so and shows the reference beside it', () => {
    const e = embedJson(
      atMsg(
        buildNotificationMessages([
          item(1, {
            shop: 'ebay',
            title: 'Lego Minecraft Karte Serie 3 Squid Ultra Rare',
            idSource: 'picture',
            pictureCardId: cid('12'),
            similarity: 0.91,
          }),
        ]),
        0
      )
    );
    expect(e.title).toBe('🟢 Card #12 Squid is available');
    expect(e.footer.text).toBe('🖼️ number from the picture (0.91) — compare with the reference');
    expect(e.thumbnail.url).toBe(referenceUrl);
  });

  test("a listing of another collection gets neither this collection's name nor reference", () => {
    const e = embedJson(
      atMsg(
        buildNotificationMessages([
          item(1, {
            collection: 'other-set' as CollectionId,
            matchStatus: 'unconfirmed',
            similarity: 0.5,
          }),
          item(2, { matchStatus: 'unconfirmed', similarity: 0.5 }),
        ]),
        0
      )
    );
    expect(e.title).toBe('🟢 Card #12 is available');
    expect(e.thumbnail).toBeUndefined();
    const same = embedJson(
      atMsg(
        buildNotificationMessages([item(2, { matchStatus: 'unconfirmed', similarity: 0.5 })]),
        0
      )
    );
    expect(same.title).toBe('🟢 Card #12 Squid is available');
    expect(same.thumbnail.url).toBe(referenceUrl);
  });

  test('a placeholder reference is never shown as the thumbnail', () => {
    setCatalogCards('lego-minecraft-3', [
      { cardId: cid('LE10'), name: 'Exploding Creeper', imageUrl: 'https://ref/mnc3_leer.jpg' },
    ]);
    const e = embedJson(
      atMsg(
        buildNotificationMessages([
          item(1, { cardIds: [cid('LE10')], matchStatus: 'unconfirmed', similarity: 0.5 }),
        ]),
        0
      )
    );
    expect(e.thumbnail).toBeUndefined();
  });

  test('a title number the picture confirms keeps the plain footer and no thumbnail', () => {
    const e = embedJson(
      atMsg(buildNotificationMessages([item(1, { pictureCardId: cid('12') })]), 0)
    );
    expect(e.footer.text).toBe('✅ picture matches reference (0.94)');
    expect(e.thumbnail).toBeUndefined();
  });

  test('a mismatch (never sent to users) names the card the picture shows', () => {
    const e = embedJson(
      atMsg(
        buildNotificationMessages([
          item(1, { matchStatus: 'mismatch', pictureCardId: cid('45'), similarity: 0.5 }),
        ]),
        0
      )
    );
    expect(e.footer.text).toBe('⚠️ the picture shows #45, not #12');
  });

  test('an admin-mapped listing reads as checked by the admin', () => {
    const e = embedJson(
      atMsg(buildNotificationMessages([item(1, { matchStatus: 'confirmed', similarity: null })]), 0)
    );
    expect(e.footer.text).toBe('✅ checked by the admin');
  });

  test('a fixed-price eBay listing says Buy It Now', () => {
    const e = embedJson(
      atMsg(
        buildNotificationMessages([
          item(1, { shop: 'ebay', format: 'fixed_price', price: { cents: 149, currency: 'EUR' } }),
        ]),
        0
      )
    );
    const price = e.fields.find((x: { name: string }) => x.name === 'Price').value;
    expect(price).toBe('1,49 € · Buy It Now');
  });

  describe('Right button', () => {
    const buttonsOf = (msg: MessageCreateOptions, row = 0) =>
      (msg.components![row] as any).toJSON().components as {
        label: string;
        custom_id?: string;
        style: number;
      }[];

    test('an unconfirmed single card gets a Right button after Wrong', () => {
      const msgs = buildNotificationMessages([item(7, { matchStatus: 'unconfirmed' })]);
      const buttons = buttonsOf(atMsg(msgs, 0));
      expect(buttons.slice(-2).map((b) => b.custom_id)).toEqual(['report:7', 'right:7']);
      expect(buttons.at(-1)!.label).toBe('✅ Right #12');
      expect(buttons.at(-1)!.style).toBe(ButtonStyle.Success);
    });

    test('no Right button unless the single card is unconfirmed', () => {
      const msgs = buildNotificationMessages([
        item(1, { matchStatus: 'confirmed' }),
        item(2, { matchStatus: 'pending' }),
        item(3, { matchStatus: 'no_reference' }),
        item(4, { matchStatus: 'unconfirmed', cardIds: [cid('12'), cid('13')] }),
        item(5, { matchStatus: 'image_unavailable' }),
        item(6, { matchStatus: 'model_unavailable' }),
        item(7, { matchStatus: 'mismatch' }),
      ]);
      const rows = msgs.flatMap((m) =>
        m.message.components!.map((_, r) => buttonsOf(m.message, r))
      );
      expect(rows).toHaveLength(7);
      for (const buttons of rows) {
        expect(buttons.some((b) => b.custom_id?.startsWith('right:'))).toBe(false);
      }
    });

    test('batched rows stay within 5 buttons and keep the position marker', () => {
      const msgs = buildNotificationMessages(
        Array.from({ length: 6 }, (_, i) => item(i + 1, { matchStatus: 'unconfirmed' }))
      );
      const first = atMsg(msgs, 0);
      for (let r = 0; r < first.components!.length; r++) {
        const buttons = buttonsOf(first, r);
        expect(buttons.length).toBeLessThanOrEqual(5);
        expect(buttons.at(-1)!.custom_id).toBe(`right:${r + 1}`);
      }
      expect(buttonsOf(first, 0)[0]!.label).toStartWith('1️⃣ ');
    });
  });
});
