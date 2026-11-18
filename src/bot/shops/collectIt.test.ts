import { describe, expect, spyOn, test } from 'bun:test';
import * as cheerio from 'cheerio';
import { createCollectItAdapter, parseCollectItPage } from './collectIt';
import { ShopLayoutError } from './types';
import logger from '../utils/logger';
import { readFixture, fakeFetch } from '../../test/shopHelpers';
import { cid } from '../../test/cardIds';

const BASE = 'https://www.collect-it.de/sammelkarten/lego/minecraft/serie-3/Einzelkarten';
const P1 = readFixture('collect-it-p1.html');
const P8 = readFixture('collect-it-p8.html');

/**
 * A saved page served as page `n`: the canonical link names `n`, and `<link rel="next">` is
 * there only when `hasNext`. collect-it serves no page past the end (it redirects to page 1),
 * so middle pages are built from the saved first and last page.
 */
function asPage(html: string, n: number, hasNext: boolean): string {
  const $ = cheerio.load(html);
  $('link[rel="canonical"]').attr('href', n === 1 ? BASE : `${BASE}_s${n}`);
  $('link[rel="next"], link[rel="prev"]').remove();
  if (hasNext) $('head').append(`<link rel="next" href="${BASE}_s${n + 1}">`);
  return $.html();
}

/** Page 1 with its first product box rewritten by `edit`, and only that box kept. */
function firstBoxOnly(edit: ($: cheerio.CheerioAPI, box: ReturnType<cheerio.CheerioAPI>) => void) {
  const $ = cheerio.load(P1);
  const boxes = $('#product-list .c-product-box');
  boxes.slice(1).remove();
  edit($, boxes.first());
  return $.html();
}

describe('parseCollectItPage', () => {
  const p1 = parseCollectItPage(P1);
  const p8 = parseCollectItPage(P8);

  test('reads id, name, price, stock, url and picture of a base card', () => {
    const squid = p1.listings.find((l) => l.cardIds[0] === '12')!;
    expect(squid).toEqual({
      shop: 'collect-it',
      url: 'https://www.collect-it.de/12-Squid-Charakterkarte-Serie-3',
      title: '12 - Squid - Charakterkarte - Serie 3',
      cardIds: [cid('12')],
      cardName: 'Squid',
      imageUrl:
        'https://www.collect-it.de/media/image/product/623996/md/12-squid-charakterkarte-serie-3.jpg',
      price: { cents: 55, currency: 'EUR' },
      available: true,
      format: 'shop',
      auctionEndsAt: null,
      idConflict: false,
    });
  });

  test('page 1 has 30 cards, all in stock, and links a next page', () => {
    expect(p1.productCount).toBe(30);
    expect(p1.listings).toHaveLength(30);
    expect(p1.listings.every((l) => l.available && l.price !== null)).toBe(true);
    expect(p1).toMatchObject({ page: 1, hasNext: true, skippedNoId: 0, skippedInvalid: 0 });
  });

  test('the last page has no next page and reads LE cards ("LE01 - ...") as LE ids', () => {
    expect(p8).toMatchObject({ page: 8, hasNext: false, productCount: 25, skippedNoId: 0 });
    expect(p8.listings).toHaveLength(25);
    const le1 = p8.listings.find((l) => l.cardIds[0] === 'LE1')!;
    expect(le1.title).toBe('LE01 - Ender Dragon - Limitierte Karte - Serie 3');
    expect(le1.cardName).toBe('Ender Dragon');
    expect(le1.price).toEqual({ cents: 119, currency: 'EUR' });
    expect(p8.listings.find((l) => l.cardIds[0] === 'LE5')!.price).toEqual({
      cents: 9900,
      currency: 'EUR',
    });
    expect(p8.listings.filter((l) => l.cardIds[0]!.startsWith('LE'))).toHaveLength(11);
  });

  test('a variant suffix after the type does not end up in the name', () => {
    const titles = new Map([...p1.listings, ...p8.listings].map((l) => [l.title, l.cardName]));
    for (const [title, name] of titles) {
      expect(title.startsWith(`${title.split(' - ')[0]} - ${name} - `)).toBe(true);
    }
  });

  test('the listing agrees with the product page on price and stock', () => {
    const $ = cheerio.load(readFixture('collect-it-product-12.html'));
    const squid = p1.listings.find((l) => l.cardIds[0] === '12')!;
    const offer = $('[itemtype="https://schema.org/Offer"]').first();
    expect(offer.find('meta[itemprop="price"]').attr('content')).toBe('0.55');
    expect(offer.find('link[itemprop="availability"]').attr('href')).toBe(
      'https://schema.org/InStock'
    );
    expect(squid.price?.cents).toBe(55);
    expect(squid.available).toBe(true);
  });

  test('a product page is not a listing page', () => {
    expect(parseCollectItPage(readFixture('collect-it-product-12.html')).productCount).toBe(0);
  });

  test('reads OutOfStock as unavailable and LimitedAvailability as available', () => {
    const page = (href: string) =>
      firstBoxOnly(($, box) => box.find('link[itemprop="availability"]').attr('href', href));
    expect(parseCollectItPage(page('https://schema.org/OutOfStock')).listings[0]?.available).toBe(
      false
    );
    expect(
      parseCollectItPage(page('https://schema.org/LimitedAvailability')).listings[0]?.available
    ).toBe(true);
    const none = firstBoxOnly(($, box) => box.find('link[itemprop="availability"]').remove());
    expect(parseCollectItPage(none).listings[0]?.available).toBe(false);
  });

  test('skips and counts a title whose card id cannot be read', () => {
    const html = firstBoxOnly(($, box) =>
      box.find('.c-product-box-content-title').text('Sammelmappe - Serie 3')
    );
    const parsed = parseCollectItPage(html);
    expect(parsed).toMatchObject({ listings: [], productCount: 1, skippedNoId: 1 });
  });

  test('skips and counts a product box without a link', () => {
    const html = firstBoxOnly(($, box) => box.find('a').removeAttr('href'));
    const parsed = parseCollectItPage(html);
    expect(parsed).toMatchObject({ listings: [], productCount: 1, skippedInvalid: 1 });
  });

  test('a missing price is null, not a parse error', () => {
    const html = firstBoxOnly(($, box) => box.find('meta[itemprop="price"]').remove());
    expect(parseCollectItPage(html).listings[0]?.price).toBeNull();
  });

  test('a page without products and without a canonical link', () => {
    expect(parseCollectItPage('<html>Just a moment...</html>')).toEqual({
      listings: [],
      productCount: 0,
      page: null,
      hasNext: false,
      skippedNoId: 0,
      skippedInvalid: 0,
    });
  });
});

describe('createCollectItAdapter', () => {
  const twoPages = () => ({
    Einzelkarten: asPage(P1, 1, true),
    _s2: asPage(P8, 2, false),
  });

  test('follows the next-page link and stops on the page without one', async () => {
    const { fetchFn, calls } = fakeFetch(twoPages());
    const sleeps: number[] = [];
    const adapter = createCollectItAdapter(fetchFn, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(adapter.id).toBe('collect-it');
    const result = await adapter.fetchListings();
    expect(calls).toEqual([BASE, `${BASE}_s2`]);
    expect(sleeps).toEqual([1500]);
    expect(result).toMatchObject({ skippedNoId: 0, skippedInvalid: 0 });
    expect(result.listings).toHaveLength(55);
    expect(result.listings.some((l) => l.cardIds[0] === '12')).toBe(true);
    expect(result.listings.some((l) => l.cardIds[0] === 'LE20')).toBe(true);
  });

  test('sums the skipped counts over the pages', async () => {
    const bad = firstBoxOnly(($, box) =>
      box.find('.c-product-box-content-title').text('Sammelmappe - Serie 3')
    );
    const { fetchFn } = fakeFetch({
      Einzelkarten: asPage(P1, 1, true),
      _s2: asPage(bad, 2, false),
    });
    const result = await createCollectItAdapter(fetchFn, { delayMs: 0 }).fetchListings();
    expect(result.skippedNoId).toBe(1);
    expect(result.listings).toHaveLength(30);
  });

  test('throws ShopLayoutError when page 1 is a bot wall', async () => {
    const { fetchFn } = fakeFetch({ Einzelkarten: '<html>Just a moment...</html>' });
    const error = await createCollectItAdapter(fetchFn, { delayMs: 0 })
      .fetchListings()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect((error as Error).message).toContain('page 1');
  });

  test('a later page without products rejects instead of ending pagination', async () => {
    const { fetchFn } = fakeFetch({
      Einzelkarten: asPage(P1, 1, true),
      _s2: '<html><body>Wartungsarbeiten</body></html>',
    });
    const error = await createCollectItAdapter(fetchFn, { delayMs: 0 })
      .fetchListings()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect((error as Error).message).toContain('page 2');
  });

  test('zero cards over all pages is a ShopLayoutError', async () => {
    const noCards = firstBoxOnly(($, box) =>
      box.find('.c-product-box-content-title').text('Sammelmappe - Serie 3')
    );
    const { fetchFn } = fakeFetch({ Einzelkarten: noCards });
    await expect(
      createCollectItAdapter(fetchFn, { delayMs: 0 }).fetchListings()
    ).rejects.toBeInstanceOf(ShopLayoutError);
  });

  test('an HTTP error rejects', async () => {
    const { fetchFn } = fakeFetch({});
    await expect(createCollectItAdapter(fetchFn, { delayMs: 0 }).fetchListings()).rejects.toThrow(
      'HTTP 404'
    );
  });

  test('stops when a linked page answers with another page (collect-it redirects past the end)', async () => {
    const warn = spyOn(logger, 'warn');
    try {
      // The shop shrank between two requests: page 2 redirects to page 1, which links page 2.
      const { fetchFn, calls } = fakeFetch({ Einzelkarten: asPage(P1, 1, true), _s2: P1 });
      const { listings } = await createCollectItAdapter(fetchFn, { delayMs: 0 }).fetchListings();
      expect(calls).toEqual([BASE, `${BASE}_s2`]);
      expect(listings).toHaveLength(30);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('asked for page 2'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('stops at the page cap when every page links a next one', async () => {
    const warn = spyOn(logger, 'warn');
    // Every page answers as the page that was asked for, and always links one more.
    const fetchFn = async (url: string) => {
      const n = Number(/_s(\d+)$/.exec(url)?.[1] ?? '1');
      return new Response(asPage(P8, n, true));
    };
    try {
      const { listings } = await createCollectItAdapter(fetchFn, { delayMs: 0 }).fetchListings();
      expect(listings).toHaveLength(25);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('stopped after 60 pages'))).toBe(
        true
      );
    } finally {
      warn.mockRestore();
    }
  }, 30_000);
});
