import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageCreateOptions } from 'discord.js';
import { db, initializeDatabase } from '../database/db';
import { cards } from '../database/schema/index';
import { catalogManager } from '../database/catalogManager';
import type { StoredListing } from '../database/listingManager';
import { buildNotificationMessages, kleinanzeigenSearchUrl } from './messages';
import { cid } from '../../test/cardIds';

const referenceUrl = 'https://ref/12.jpg';

function listing(i: number, over: Partial<StoredListing> = {}): StoredListing {
  return {
    id: i,
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

describe('notification messages', () => {
  beforeAll(() => {
    initializeDatabase();
  });
  beforeEach(() => {
    db.delete(cards).run();
    catalogManager.seedIfEmpty();
    catalogManager.updateNamesAndReferences([
      { cardId: cid('12'), name: 'Squid', imageUrl: referenceUrl },
    ]);
  });

  test('kleinanzeigenSearchUrl lowercases the id', () => {
    expect(kleinanzeigenSearchUrl(cid('LE8'))).toBe(
      'https://www.kleinanzeigen.de/s-lego-minecraft-karte-le8/k0'
    );
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
    expect(e.title).toBe('1️⃣ 🟢 Card #12 Squid is available');
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
    expect(embedJson(at(msgs, 0).message, 0).title).toBe('1️⃣ 🟢 Card #45 is available');
    const e = embedJson(at(msgs, 0).message, 1);
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
    const ref = f({ matchStatus: 'reference', shop: 'sammel-ente' });
    expect(ref.footer).toBeUndefined();
    expect(ref.fields.map((x: { value: string }) => x.value).join('|')).toContain('sammel-ente');
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
    expect(e.title).toBe('1️⃣ 🟢 Bundle with #12, #45 on eBay');
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
      '1️⃣ Bundle · eBay',
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
    const message = atMsg(msgs, 0);
    const labels = (i: number) =>
      (message.components![i] as any).toJSON().components.map((c: { label: string }) => c.label);
    expect(labels(0)).toEqual(['1️⃣ Kleinanzeigen #12', '❌ Wrong #12']);
    expect(embedJson(message, 0).url).toBeUndefined();
    expect(embedJson(message, 1).image).toBeUndefined();
    expect(labels(1)).toContain('2️⃣ #12 · blue-ocean');
    expect(labels(2)).toEqual(['3️⃣ Kleinanzeigen #12', '❌ Wrong #12']);
    expect(at(msgs, 0).items.map((x) => x.listing.id)).toEqual([1, 2, 3]);
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
});
