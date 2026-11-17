import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageCreateOptions } from 'discord.js';
import { db, initializeDatabase } from '../database/db';
import { cards } from '../database/schema/index';
import { catalogManager } from '../database/catalogManager';
import type { StoredListing } from '../database/listingManager';
import { buildNotificationMessages, kleinanzeigenSearchUrl } from './messages';

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
    cardIds: ['12'],
    matchStatus: 'confirmed',
    similarity: 0.94,
    onHold: false,
    manualOverride: false,
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
      { cardId: '12', name: 'Squid', imageUrl: referenceUrl },
    ]);
  });

  test('kleinanzeigenSearchUrl lowercases the id', () => {
    expect(kleinanzeigenSearchUrl('LE8')).toBe(
      'https://www.kleinanzeigen.de/s-lego-minecraft-karte-le8/k0'
    );
  });

  test('batches 5 items per message with link and report buttons', () => {
    const msgs = buildNotificationMessages(Array.from({ length: 7 }, (_, i) => item(i + 1)));
    expect(msgs).toHaveLength(2);
    expect(at(msgs, 0).embeds).toHaveLength(5);
    expect(at(msgs, 0).components).toHaveLength(5);
    expect(at(msgs, 1).embeds).toHaveLength(2);
    const row = (at(msgs, 0).components![0] as any).toJSON();
    expect(row.components.map((c: { label: string }) => c.label)).toEqual([
      'Open in shop',
      'Kleinanzeigen',
      '❌ Wrong card',
    ]);
    expect(row.components[0].url).toBe('https://shop/1');
    expect(row.components[1].url).toBe('https://www.kleinanzeigen.de/s-lego-minecraft-karte-12/k0');
    expect(row.components[2].custom_id).toBe('report:1');
  });

  test('embed title, fields, image and confirmed footer', () => {
    const e = embedJson(at(buildNotificationMessages([item(1)]), 0));
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
      item(1, { cardIds: ['45'], matchStatus: 'unconfirmed', similarity: 0.5 }),
      item(2, { matchStatus: 'unconfirmed', similarity: 0.5 }),
    ]);
    expect(embedJson(at(msgs, 0), 0).title).toBe('🟢 Card #45 is available');
    const e = embedJson(at(msgs, 0), 1);
    expect(e.footer.text).toContain('⚠️ number unconfirmed');
    expect(e.thumbnail.url).toBe(referenceUrl);
  });

  test('footers for other statuses; reference has none; null image and null reference', () => {
    const f = (over: Partial<StoredListing>) =>
      embedJson(at(buildNotificationMessages([item(1, over)]), 0));
    expect(f({ matchStatus: 'bundle', cardIds: ['12', '45'], shop: 'ebay' }).footer.text).toBe(
      'ℹ️ bundle — check the listing'
    );
    expect(f({ matchStatus: 'no_reference' }).footer.text).toBe('ℹ️ no reference picture yet');
    expect(f({ matchStatus: 'model_unavailable' }).footer.text).toBe(
      'ℹ️ picture check unavailable'
    );
    const ref = f({ matchStatus: 'reference', shop: 'sammel-ente' });
    expect(ref.footer).toBeUndefined();
    expect(ref.fields.map((x: { value: string }) => x.value).join('|')).toContain('sammel-ente');
    expect(f({ imageUrl: null }).image).toBeUndefined();
    const noRef = f({ matchStatus: 'unconfirmed', cardIds: ['45'] });
    expect(noRef.thumbnail).toBeUndefined();
  });

  test('bundle title and eBay auction price', () => {
    const e = embedJson(
      at(
        buildNotificationMessages([
          item(1, {
            shop: 'ebay',
            cardIds: ['12', '45'],
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
    const ids = Array.from({ length: 200 }, (_, i) => String(i + 1));
    const e = embedJson(
      at(
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
    expect(e.fields.find((x: { name: string }) => x.name === 'Price').value).toBe('5.00 USD');
  });
});
