import { describe, test, expect } from 'bun:test';
import * as cheerio from 'cheerio';
import { parseBlueOceanPage, createBlueOceanAdapter } from './blueOcean';
import { ShopLayoutError } from './types';
import { readFixture, fakeFetch } from '../../test/shopHelpers';

function box(href: string, title: string, image: string, stock = 'Auf Lager'): string {
  return `<div class="product-card product-box"><img data-testid="product-box-img" src="${image}">
    <a data-testid="product-box-product-name-link" href="${href}"><div>${title}</div></a>
    <div data-testid="product-box-product-price"><p aria-label="Preis: 0.8"><span>0.8</span></p></div>
    <span>${stock}</span></div>`;
}

describe('parseBlueOceanPage', () => {
  const b1 = parseBlueOceanPage(readFixture('blue-ocean-p1.html'));

  test('uses the href number as card id, not the title number', () => {
    const squid = b1.listings.find((l) => l.url.endsWith('-2dd00088-12'))!;
    expect(squid.cardIds).toEqual(['12']); // title says "Nr. 9"
    expect(squid).toMatchObject({
      shop: 'blue-ocean',
      cardName: null,
      format: 'shop',
      available: true,
      idConflict: false,
      auctionEndsAt: null,
      price: { cents: 80, currency: 'EUR' },
    });
    expect(squid.url).toBe(
      'https://www.blue-ocean.de/nr.-9-squid-uncommonlego-minecraft-tcc-on-fire-2dd00088-12'
    );
    expect(squid.imageUrl).toContain('P12.jpg');
    expect(b1.listings.find((l) => l.url.endsWith('-107'))!.cardIds).toEqual(['107']);
  });

  test('keeps only TCC cards and counts only the listing grid as products', () => {
    expect(b1.listings.every((l) => l.title.includes('LEGO Minecraft TCC'))).toBe(true);
    expect(b1.listings.every((l) => l.title.includes('On Fire'))).toBe(true);
    expect(b1.listings).toHaveLength(19);
    // recommendation slider boxes are not part of the listing
    expect(b1.productCount).toBe(24);
  });

  test('skips series 2 TCC products but still counts them as products', () => {
    // No saved fixture holds a non-"On Fire" TCC product, so rewrite a real product box.
    const $ = cheerio.load(readFixture('blue-ocean-p1.html'));
    const link = $('a[data-testid="product-box-product-name-link"]').first();
    link.attr('href', '/nr.-5-creeper-commonlego-minecraft-tcc-serie-2-2dd00088-5');
    link.find('div').first().text('Nr. 5 Creeper| CommonLEGO Minecraft TCC Serie 2');
    const boxHtml = $.html(link.closest('[data-testid="product-box"], .product-card'));
    const parsed = parseBlueOceanPage(`<div class="cms-page">${boxHtml}</div>`);
    expect(parsed.productCount).toBe(1);
    expect(parsed.listings).toEqual([]);
  });

  test('page 99 has no products', () => {
    expect(parseBlueOceanPage(readFixture('blue-ocean-p99.html'))).toEqual({
      listings: [],
      productCount: 0,
      isCategoryPage: true,
    });
  });

  test('parses page 2', () => {
    const b2 = parseBlueOceanPage(readFixture('blue-ocean-p2.html'));
    expect(b2.productCount).toBeGreaterThan(0);
    expect(b2.listings.some((l) => l.cardIds[0] === '93')).toBe(true);
  });

  test('flags a disagreement between the url number and the image number', () => {
    const html = box(
      '/nr.-1-foo-lego-minecraft-tcc-on-fire-2dd00088-5',
      'Nr. 1 Foo LEGO Minecraft TCC "On Fire"',
      'https://x.test/a/TCG3_.P7.jpg?ts=1'
    );
    const [l] = parseBlueOceanPage(html).listings;
    expect(l?.cardIds).toEqual(['5']);
    expect(l?.idConflict).toBe(true);
  });

  test('reads a sold out card as unavailable', () => {
    const html = box(
      '/nr.-1-foo-lego-minecraft-tcc-on-fire-2dd00088-5',
      'Nr. 1 Foo LEGO Minecraft TCC "On Fire"',
      'https://x.test/a/TCG3_.P5.jpg',
      'Nicht verfügbar'
    );
    expect(parseBlueOceanPage(html).listings[0]?.available).toBe(false);
  });

  test('skips a TCC product whose id cannot be read', () => {
    const html = box(
      '/lego-minecraft-tcc-on-fire-display',
      'LEGO Minecraft TCC "On Fire" Display',
      ''
    );
    const parsed = parseBlueOceanPage(html);
    expect(parsed.listings).toEqual([]);
    expect(parsed.productCount).toBe(1);
  });
});

describe('createBlueOceanAdapter', () => {
  const base =
    'https://www.blue-ocean.de/produkte/lego/lego-minecraft/lego-minecraft-sticker-cards/';

  test('throws ShopLayoutError when page 1 is not a shop page', async () => {
    const { fetchFn } = fakeFetch({ '?p=1': '<html>Just a moment...</html>' });
    await expect(
      createBlueOceanAdapter(fetchFn, { delayMs: 0 }).fetchListings()
    ).rejects.toBeInstanceOf(ShopLayoutError);
  });

  test('walks pages until one has no products', async () => {
    const { fetchFn, calls } = fakeFetch({
      '?p=1': readFixture('blue-ocean-p1.html'),
      '?p=2': readFixture('blue-ocean-p2.html'),
      '?p=3': readFixture('blue-ocean-p99.html'),
    });
    const sleeps: number[] = [];
    const adapter = createBlueOceanAdapter(fetchFn, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(adapter.id).toBe('blue-ocean');
    const listings = await adapter.fetchListings();
    expect(calls).toEqual([`${base}?p=1`, `${base}?p=2`, `${base}?p=3`]);
    expect(sleeps).toEqual([1500, 1500]);
    expect(listings.some((l) => l.cardIds[0] === '12')).toBe(true);
    expect(listings.some((l) => l.cardIds[0] === '93')).toBe(true);
  });

  test('a bot wall on a later page rejects instead of ending pagination', async () => {
    const { fetchFn } = fakeFetch({
      '?p=1': readFixture('blue-ocean-p1.html'),
      '?p=2': '<html>Just a moment...</html>',
    });
    const error = await createBlueOceanAdapter(fetchFn, { delayMs: 0 })
      .fetchListings()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect((error as Error).message).toContain('page 2');
  });

  test('stops at the page cap when the shop never runs out of products', async () => {
    const { fetchFn, calls } = fakeFetch({ '?p=': readFixture('blue-ocean-p1.html') });
    const listings = await createBlueOceanAdapter(fetchFn, { delayMs: 0 }).fetchListings();
    expect(calls).toHaveLength(60);
    // identical pages are deduplicated by url
    expect(listings).toHaveLength(19);
  });
});
