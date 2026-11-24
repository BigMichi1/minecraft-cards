import { describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
import { parseSammelEntePage, createSammelEnteFetcher } from './sammelEnte';
import { ShopLayoutError } from './types';
import { HttpError } from '../utils/http';
import { readFixture, fakeFetch } from '../../test/shopHelpers';
import { cid } from '../../test/cardIds';
import { legoMinecraft3 } from '../collections/legoMinecraft3';

const SERIES_3 = legoMinecraft3.shops['sammel-ente']!;

describe('parseSammelEntePage', () => {
  const p1 = parseSammelEntePage(readFixture('sammel-ente-p1.html'), null);

  test('reads the last page from the pagination', () => {
    expect(p1.lastPage).toBe(11);
  });

  test('parses a base card with name, url, image, price and stock', () => {
    const squid = p1.listings.find((l) => l.cardIds[0] === '12')!;
    expect(squid).toMatchObject({
      shop: 'sammel-ente',
      cardIds: ['12'],
      cardName: 'Squid',
      format: 'shop',
      available: true,
      auctionEndsAt: null,
      idConflict: false,
      price: { cents: 55, currency: 'EUR' },
      url: 'https://shop-sammel-ente.de/LEGO-Minecraft-Serie-3-012-Squid/MNC-03XX-BAS-0012',
    });
    expect(squid.title).toBe('LEGO Minecraft Serie 3 | #012 Squid');
    expect(squid.imageUrl).toContain('mnc3_012.jpg');
  });

  test('a sold out card is unavailable and has no price', () => {
    const sold = p1.listings.find((l) => l.cardIds[0] === '2')!;
    expect(sold.available).toBe(false);
    expect(sold.price).toBeNull();
  });

  test('parses German prices with a decimal comma', () => {
    expect(p1.listings.find((l) => l.cardIds[0] === '4')!.price).toEqual({
      cents: 2475,
      currency: 'EUR',
    });
  });

  test('skips boosters and starter packs', () => {
    expect(p1.listings.some((l) => l.title.includes('Booster'))).toBe(false);
    expect(p1.listings.some((l) => l.title.includes('Starter'))).toBe(false);
    expect(p1.listings).toHaveLength(22);
    expect(p1.productCount).toBeGreaterThan(22);
    expect(p1.skippedNoId).toBe(0);
    expect(p1.skippedInvalid).toBe(0);
  });

  test('counts only card-numbered titles whose id cannot be read as skipped without an id', () => {
    const box = (title: string) =>
      `<div class="card product-box"><a class="product-name" href="/x">${title}</a></div>`;
    const parsed = parseSammelEntePage(
      box('LEGO Minecraft Serie 3 | #Mystery') +
        box('LEGO Minecraft Serie 3 |#abc') +
        box('LEGO Minecraft Serie 3 | #000 Zero') +
        box('LEGO Minecraft Serie 3 Booster') +
        box('Puzzle-Paket #1 (154 - 162)'),
      null
    );
    expect(parsed).toMatchObject({ productCount: 5, skippedNoId: 3, skippedInvalid: 0 });
    expect(parsed.listings).toEqual([]);
  });

  test('counts product boxes without a link or title as invalid', () => {
    const parsed = parseSammelEntePage(
      '<div class="card product-box"><a class="product-name"></a></div>',
      null
    );
    expect(parsed).toMatchObject({ productCount: 1, skippedInvalid: 1, skippedNoId: 0 });
  });

  test('maps LE and XXL cards and skips puzzle packs on the last page', () => {
    const p11 = parseSammelEntePage(readFixture('sammel-ente-p11.html'), null);
    expect(p11.lastPage).toBe(11);
    const ids = p11.listings.map((l) => l.cardIds[0]);
    expect(ids).toContain(cid('LE12'));
    expect(ids).toContain(cid('XXL1'));
    expect(p11.listings.find((l) => l.cardIds[0] === 'LE12')).toMatchObject({
      cardName: 'Efe',
      available: true,
    });
    expect(p11.listings.find((l) => l.cardIds[0] === 'XXL1')!.available).toBe(false);
    expect(p11.listings.some((l) => l.title.includes('Puzzle'))).toBe(false);
  });

  test('a page that is not a shop page yields nothing and one page', () => {
    expect(parseSammelEntePage('<html>Just a moment...</html>', null)).toEqual({
      listings: [],
      lastPage: 1,
      productCount: 0,
      skippedNoId: 0,
      skippedExcluded: 0,
      noSeries: [],
      skippedInvalid: 0,
    });
  });
});

describe('createSammelEnteFetcher', () => {
  const noDelay = { delayMs: 0 };

  test('throws ShopLayoutError when page 1 is not a shop page', async () => {
    const { fetchFn } = fakeFetch({ '?p=1': '<html>Just a moment...</html>' });
    await expect(
      createSammelEnteFetcher(SERIES_3, fetchFn, noDelay).fetchListings()
    ).rejects.toBeInstanceOf(ShopLayoutError);
  });

  test('fetches every page up to the last one, pausing between requests', async () => {
    const { fetchFn, calls } = fakeFetch({
      '?p=1': readFixture('sammel-ente-p1.html'),
      '?p=11': readFixture('sammel-ente-p11.html'),
      '?p=': readFixture('sammel-ente-p11.html'),
    });
    const sleeps: number[] = [];
    const adapter = createSammelEnteFetcher(SERIES_3, fetchFn, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(adapter.id).toBe('sammel-ente');
    const result = await adapter.fetchListings();
    const { listings } = result;
    // The series filter keeps every series 3 card of the saved pages, and excludes none.
    expect(result.skippedExcluded).toBe(0);
    expect(listings).toHaveLength(
      new Set(
        [
          ...parseSammelEntePage(readFixture('sammel-ente-p1.html'), null).listings,
          ...parseSammelEntePage(readFixture('sammel-ente-p11.html'), null).listings,
        ].map((l) => l.url)
      ).size
    );
    expect(calls).toHaveLength(11);
    expect(calls[0]).toBe('https://shop-sammel-ente.de/Minecraft/Serie-3/?p=1');
    expect(calls[10]).toBe('https://shop-sammel-ente.de/Minecraft/Serie-3/?p=11');
    expect(sleeps).toEqual(Array(10).fill(1500));
    expect(listings.some((l) => l.cardIds[0] === 'XXL1')).toBe(true);
    expect(listings.some((l) => l.cardIds[0] === '12')).toBe(true);
  });

  test('a bot wall on a later page rejects instead of returning partial listings', async () => {
    const { fetchFn } = fakeFetch({
      '?p=1': readFixture('sammel-ente-p1.html'),
      '?p=2': '<html>Just a moment...</html>',
    });
    const error = await createSammelEnteFetcher(SERIES_3, fetchFn, noDelay)
      .fetchListings()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect((error as Error).message).toContain('page 2');
  });

  test('warns and reads only the first 60 pages when the pagination names more', async () => {
    const warn = spyOn(logger, 'warn');
    try {
      const p1 = readFixture('sammel-ente-p1.html').replaceAll('?p=11', '?p=75');
      const { fetchFn, calls } = fakeFetch({
        '?p=1': p1,
        '?p=': readFixture('sammel-ente-p11.html'),
      });
      await createSammelEnteFetcher(SERIES_3, fetchFn, noDelay).fetchListings();
      expect(calls).toHaveLength(60);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('75 pages'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  test('an HTTP failure on a later page rejects the whole run', async () => {
    const { fetchFn } = fakeFetch({ '?p=1': readFixture('sammel-ente-p1.html') });
    await expect(
      createSammelEnteFetcher(SERIES_3, fetchFn, noDelay).fetchListings()
    ).rejects.toBeInstanceOf(HttpError);
  });
});

describe('series 1', () => {
  test('the series 1 category is read from its settings', async () => {
    const { fetchFn, calls } = fakeFetch({
      '?p=1': readFixture('sammel-ente-serie-1-p1.html'),
      '?p=12': readFixture('sammel-ente-serie-1-p12.html'),
      '?p=': '<div class="card product-box"></div>',
    });
    const settings = {
      category: 'https://shop-sammel-ente.de/Minecraft/Serie-1/',
      series: 'Serie 1',
    };
    const { listings } = await createSammelEnteFetcher(settings, fetchFn, {
      delayMs: 0,
    }).fetchListings();
    expect(calls[0]).toBe('https://shop-sammel-ente.de/Minecraft/Serie-1/?p=1');
    const ids = listings.map((l) => l.cardIds[0]);
    expect(ids).toContain(cid('1'));
    expect(ids).toContain(cid('LE8'));
    expect(ids).toContain(cid('XXL1'));
  });

  test('a card of another series, or naming none, is skipped and counted', () => {
    const box = (title: string, href: string) =>
      `<div class="card product-box"><a class="product-name" href="${href}">${title}</a></div>`;
    const html = [
      box('LEGO Minecraft Serie 1 | #001 Steve', '/a'),
      box('LEGO Minecraft Serie 3 | #012 Squid', '/b'),
      box('LEGO Minecraft | #013 Pig', '/c'),
    ].join('');
    const page = parseSammelEntePage(html, 'Serie 1');
    expect(page.listings.map((l) => l.cardIds[0])).toEqual([cid('1')]);
    expect(page.skippedExcluded).toBe(1);
    expect(page.noSeries).toEqual(['LEGO Minecraft | #013 Pig']);
  });

  test('a card title naming no series fails the read: the title format changed', async () => {
    const html =
      '<div class="card product-box"><a class="product-name" href="/a">LEGO Minecraft Serie 1 | #001 Steve</a></div>' +
      '<div class="card product-box"><a class="product-name" href="/c">LEGO Minecraft | #013 Pig</a></div>';
    const { fetchFn } = fakeFetch({ '?p=1': html });
    const settings = {
      category: 'https://shop-sammel-ente.de/Minecraft/Serie-1/',
      series: 'Serie 1',
    };
    await expect(
      createSammelEnteFetcher(settings, fetchFn, { delayMs: 0 }).fetchListings()
    ).rejects.toThrow('sammel-ente: a card title names no series: "LEGO Minecraft | #013 Pig"');
  });

  test('the series is read however it is spaced', () => {
    const html =
      '<div class="card product-box"><a class="product-name" href="/a">LEGO Minecraft Serie1 | #001 Steve</a></div>' +
      '<div class="card product-box"><a class="product-name" href="/b">LEGO Minecraft Serie 1 TCC | #002 Alex</a></div>';
    expect(parseSammelEntePage(html, 'Serie 1').listings).toHaveLength(2);
  });

  test("another series on a later page is counted with the first page's", async () => {
    const card = (n: number, s: number) =>
      `<div class="card product-box"><a class="product-name" href="/c${n}">LEGO Minecraft Serie ${s} | #00${n} Card</a></div>`;
    const page1 = `${card(1, 1)}<a href="?p=2">2</a>`;
    const page2 = `${card(2, 1)}${card(3, 3)}`;
    const { fetchFn } = fakeFetch({ '?p=1': page1, '?p=2': page2 });
    const settings = {
      category: 'https://shop-sammel-ente.de/Minecraft/Serie-1/',
      series: 'Serie 1',
    };
    const result = await createSammelEnteFetcher(settings, fetchFn, { delayMs: 0 }).fetchListings();
    expect(result.listings).toHaveLength(2);
    expect(result.skippedExcluded).toBe(1);
  });

  test('the series number is compared as a number', () => {
    const html =
      '<div class="card product-box"><a class="product-name" href="/a">LEGO Minecraft Serie 01 | #001 Steve</a></div>';
    expect(parseSammelEntePage(html, 'Serie 1').listings).toHaveLength(1);
  });

  test('a card title naming no series on a later page fails the read too, counted', async () => {
    const box = (href: string, title: string) =>
      `<div class="card product-box"><a class="product-name" href="${href}">${title}</a></div>`;
    const page1 = `${box('/a', 'LEGO Minecraft Serie 1 | #001 Steve')}<a href="?p=2">2</a>`;
    const page2 = `${box('/b', 'LEGO Minecraft | #013 Pig')}${box('/c', 'LEGO Minecraft | #014 Cow')}`;
    const { fetchFn } = fakeFetch({ '?p=1': page1, '?p=2': page2 });
    const settings = {
      category: 'https://shop-sammel-ente.de/Minecraft/Serie-1/',
      series: 'Serie 1',
    };
    await expect(
      createSammelEnteFetcher(settings, fetchFn, { delayMs: 0 }).fetchListings()
    ).rejects.toThrow('names no series: "LEGO Minecraft | #013 Pig" and 1 more');
  });

  test('"Serie 13" is no "Serie 1"', () => {
    const html =
      '<div class="card product-box"><a class="product-name" href="/a">LEGO Minecraft Serie 13 | #001 Steve</a></div>';
    expect(parseSammelEntePage(html, 'Serie 1')).toMatchObject({
      listings: [],
      skippedExcluded: 1,
    });
  });
});
