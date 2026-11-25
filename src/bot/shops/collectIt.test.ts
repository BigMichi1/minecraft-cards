import { describe, expect, spyOn, test } from 'bun:test';
import * as cheerio from 'cheerio';
import {
  createCollectItFetcher,
  parseCollectItPage,
  readArticleTotal,
  type CollectItPage,
} from './collectIt';
import { ShopLayoutError } from './types';
import logger from '../utils/logger';
import { readFixture, fakeFetch } from '../../test/shopHelpers';
import { cid } from '../../test/cardIds';
import { legoMinecraft1 } from '../collections/legoMinecraft1';
import { legoMinecraft3 } from '../collections/legoMinecraft3';
import { turboAttax2026 } from '../collections/turboAttax2026';
import { MINECRAFT_CARD_IDS, TURBO_ATTAX_CARD_IDS } from '../cards/cardId';
import { sameSeries } from './types';

const SERIES_3 = legoMinecraft3.shops['collect-it']!;
const SERIES_1 = legoMinecraft1.shops['collect-it']!;

const BASE = 'https://www.collect-it.de/sammelkarten/lego/minecraft/serie-3/Einzelkarten';
const P1 = readFixture('collect-it-p1.html');
const P8 = readFixture('collect-it-p8.html');

/**
 * A saved page served as page `n`: the canonical link names `n`, and `<link rel="next">` is
 * there only when `hasNext`. With `total`, the pagination text names that article total (the
 * "N von total" form on a page with a next page, "alle total" on the last). collect-it serves
 * no page past the end (it redirects to page 1), so middle pages are built from the saved first
 * and last page.
 */
function asPage(html: string, n: number, hasNext: boolean, total?: number): string {
  const $ = cheerio.load(html);
  $('link[rel="canonical"]').attr('href', n === 1 ? BASE : `${BASE}_s${n}`);
  $('link[rel="next"], link[rel="prev"]').remove();
  if (hasNext) $('head').append(`<link rel="next" href="${BASE}_s${n + 1}">`);
  if (total !== undefined) {
    $('.ci-pagination-meta').html(
      hasNext
        ? `Du hast <strong>${n * 30} von ${total}</strong> Artikeln gesehen`
        : `Du hast <strong>alle ${total}</strong> Artikel gesehen`
    );
  }
  return $.html();
}

/** `html` with its pagination text set to `text`, or removed when `text` is null. */
function withCountText(html: string, text: string | null): string {
  const $ = cheerio.load(html);
  if (text === null) $('.ci-pagination-meta').remove();
  else $('.ci-pagination-meta').text(text);
  return $.html();
}

/** `html` with its last `n` product boxes removed. */
function dropBoxes(html: string, n: number): string {
  const $ = cheerio.load(html);
  $('#product-list .c-product-box').slice(-n).remove();
  return $.html();
}

/** `html` with its canonical link set to `href`, or removed when `href` is null. */
function withCanonical(html: string, href: string | null): string {
  const $ = cheerio.load(html);
  if (href === null) $('link[rel="canonical"]').remove();
  else $('link[rel="canonical"]').attr('href', href);
  return $.html();
}

/** `html` with its next-page link set to `href`. */
function withNext(html: string, href: string): string {
  const $ = cheerio.load(html);
  $('link[rel="next"]').remove();
  $('head').append(`<link rel="next" href="${href}">`);
  return $.html();
}

/** The adapter's rejection for these pages (fails the test when it resolves). */
async function rejection(pages: Record<string, string>): Promise<Error> {
  const { fetchFn } = fakeFetch(pages);
  const error = await createCollectItFetcher(SERIES_3, fetchFn, { delayMs: 0 })
    .fetchListings()
    .then(
      () => new Error('resolved'),
      (e: unknown) => e as Error
    );
  expect(error).toBeInstanceOf(ShopLayoutError);
  return error;
}

/** Page 1 with its first product box rewritten by `edit`, and only that box kept. */
function firstBoxOnly(edit: ($: cheerio.CheerioAPI, box: ReturnType<cheerio.CheerioAPI>) => void) {
  const $ = cheerio.load(P1);
  const boxes = $('#product-list .c-product-box');
  boxes.slice(1).remove();
  edit($, boxes.first());
  return $.html();
}

/** Runs `fn` with `logger.warn` spied, and returns the warned messages. */
function warnings(fn: () => void): string[] {
  const warn = spyOn(logger, 'warn');
  try {
    fn();
    return warn.mock.calls.map((c) => String(c[0]));
  } finally {
    warn.mockRestore();
  }
}

describe('parseCollectItPage', () => {
  const p1: CollectItPage = parseCollectItPage(P1, null);
  const p8: CollectItPage = parseCollectItPage(P8, null);

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
    expect(p1).toMatchObject({
      canonical: BASE,
      next: `${BASE}_s2`,
      skippedNoId: 0,
      skippedInvalid: 0,
    });
  });

  test('the last page has no next page and reads LE cards ("LE01 - ...") as LE ids', () => {
    expect(p8).toMatchObject({
      canonical: `${BASE}_s8`,
      next: null,
      productCount: 25,
      skippedNoId: 0,
    });
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
    const nameOf = (title: string) => p1.listings.find((l) => l.title === title)?.cardName;
    expect(nameOf('14 - Alex - Charakterkarte - Lava - Serie 3')).toBe('Alex');
    expect(nameOf('13 - Skeleton - Charakterkarte - Holo - Serie 3')).toBe('Skeleton');
    expect(nameOf('6 - Zombie - Charakterkarte - Ultra - Serie 3')).toBe('Zombie');
  });

  describe('titles and links', () => {
    const withTitle = (title: string) =>
      parseCollectItPage(
        firstBoxOnly(($, box) => box.find('.c-product-box-content-title').text(title)),
        null
      ).listings[0];

    test('an XXL title maps to the XXL id', () => {
      const xxl = withTitle('XXL1 - Ender Dragon - XXL Karte - Serie 3');
      expect(xxl?.cardIds).toEqual([cid('XXL1')]);
      expect(xxl?.cardName).toBe('Ender Dragon');
    });

    test('a title with nothing after the name keeps the name', () => {
      const squid = withTitle('12 - Squid');
      expect(squid?.cardIds).toEqual([cid('12')]);
      expect(squid?.cardName).toBe('Squid');
    });

    test('a lowercase LE prefix is read and made canonical', () => {
      // TITLE_PATTERN is case-insensitive and normalizeCardId uppercases the prefix.
      expect(withTitle('le01 - Ender Dragon - Limitierte Karte - Serie 3')?.cardIds).toEqual([
        cid('LE1'),
      ]);
    });

    test('a relative product href is resolved against the shop', () => {
      const html = firstBoxOnly(($, box) =>
        box.find('a[href]').attr('href', '/1-Alex-Charakterkarte-Serie-3')
      );
      expect(parseCollectItPage(html, null).listings[0]?.url).toBe(
        'https://www.collect-it.de/1-Alex-Charakterkarte-Serie-3'
      );
    });

    test('a box with a link but no title is skipped as invalid, naming its link', () => {
      const parsed = parseCollectItPage(
        firstBoxOnly(($, box) => box.find('.c-product-box-content-title').remove()),
        null
      );
      expect(parsed).toMatchObject({ listings: [], productCount: 1, skippedInvalid: 1 });
      expect(parsed.firstSkipped).toBe(
        'a product box without a title (https://www.collect-it.de/1-Alex-Charakterkarte-Serie-3)'
      );
    });
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
    expect(parseCollectItPage(readFixture('collect-it-product-12.html'), null).productCount).toBe(
      0
    );
  });

  describe('availability', () => {
    const withAvailability = (href: string) =>
      parseCollectItPage(
        firstBoxOnly(($, box) => box.find('link[itemprop="availability"]').attr('href', href)),
        null
      );
    for (const [href, available] of [
      ['https://schema.org/InStock', true],
      ['http://schema.org/InStock', true],
      ['InStock', true],
      ['https://schema.org/instock', true],
      ['https://schema.org/LimitedAvailability', true],
      ['https://schema.org/OnlineOnly', true],
      ['https://schema.org/OutOfStock', false],
      ['https://schema.org/SoldOut', false],
      ['https://schema.org/Discontinued', false],
      ['https://schema.org/PreOrder', false],
    ] as const) {
      test(`${href} reads as ${available ? 'in stock' : 'not available'}`, () => {
        const parsed = withAvailability(href);
        expect(parsed.skippedInvalid).toBe(0);
        expect(parsed.listings[0]?.available).toBe(available);
      });
    }

    test('a value outside the schema.org set is an unreadable box, naming the value', () => {
      const parsed = withAvailability('https://schema.org/Banana');
      expect(parsed).toMatchObject({ listings: [], productCount: 1, skippedInvalid: 1 });
      expect(parsed.firstSkipped).toContain('https://schema.org/Banana');
      expect(parsed.firstSkipped).toContain('1 - Alex');
    });

    test('a box without availability is an unreadable box', () => {
      const parsed = parseCollectItPage(
        firstBoxOnly(($, box) => box.find('link[itemprop="availability"]').remove()),
        null
      );
      expect(parsed).toMatchObject({ listings: [], productCount: 1, skippedInvalid: 1 });
      expect(parsed.firstSkipped).toContain('no availability');
    });
  });

  test('skips and counts a title whose card id cannot be read', () => {
    const html = firstBoxOnly(($, box) =>
      box.find('.c-product-box-content-title').text('Sammelmappe - Serie 3')
    );
    const parsed = parseCollectItPage(html, null);
    expect(parsed).toMatchObject({ listings: [], productCount: 1, skippedNoId: 1 });
    expect(parsed.firstSkipped).toContain('"Sammelmappe - Serie 3"');
  });

  test('skips and counts a product box without a link', () => {
    const html = firstBoxOnly(($, box) => box.find('a').removeAttr('href'));
    const parsed = parseCollectItPage(html, null);
    expect(parsed).toMatchObject({ listings: [], productCount: 1, skippedInvalid: 1 });
    expect(parsed.firstSkipped).toContain('without a link');
    expect(parsed.firstSkipped).toContain('1 - Alex');
  });

  test('a missing price is null with a warning, not a parse error', () => {
    const html = firstBoxOnly(($, box) => box.find('meta[itemprop="price"]').remove());
    let parsed: CollectItPage | undefined;
    const warned = warnings(() => (parsed = parseCollectItPage(html, null)));
    expect(parsed?.listings[0]?.price).toBeNull();
    expect(warned.some((w) => w.includes('no price'))).toBe(true);
  });

  for (const raw of ['0,55', '0.555']) {
    test(`a malformed price "${raw}" is null and the warning names the raw value`, () => {
      const html = firstBoxOnly(($, box) =>
        box.find('meta[itemprop="price"]').attr('content', raw)
      );
      let parsed: CollectItPage | undefined;
      const warned = warnings(() => (parsed = parseCollectItPage(html, null)));
      expect(parsed?.listings[0]?.price).toBeNull();
      expect(warned.some((w) => w.includes(`"${raw}"`) && w.includes('1 - Alex'))).toBe(true);
    });
  }

  test('a missing priceCurrency defaults to EUR', () => {
    const html = firstBoxOnly(($, box) => box.find('meta[itemprop="priceCurrency"]').remove());
    expect(parseCollectItPage(html, null).listings[0]?.price).toEqual({
      cents: 55,
      currency: 'EUR',
    });
  });

  test('the picture falls back to the <img> src, resolved against the shop', () => {
    const html = firstBoxOnly(($, box) => {
      box.find('meta[itemprop="image"]').remove();
      box
        .find('.c-product-box-thumbnail img')
        .attr('src', '/media/image/product/623985/sm/1-alex.jpg');
    });
    expect(parseCollectItPage(html, null).listings[0]?.imageUrl).toBe(
      'https://www.collect-it.de/media/image/product/623985/sm/1-alex.jpg'
    );
  });

  test('a relative image meta is resolved against the shop', () => {
    const html = firstBoxOnly(($, box) =>
      box
        .find('meta[itemprop="image"]')
        .attr('content', '/media/image/product/623985/md/1-alex.jpg')
    );
    expect(parseCollectItPage(html, null).listings[0]?.imageUrl).toBe(
      'https://www.collect-it.de/media/image/product/623985/md/1-alex.jpg'
    );
  });

  test('a page without products and without a canonical link', () => {
    expect(parseCollectItPage('<html>Just a moment...</html>', null)).toEqual({
      listings: [],
      productCount: 0,
      canonical: null,
      next: null,
      excluded: [],
      skippedNoId: 0,
      skippedInvalid: 0,
      firstSkipped: null,
      countText: null,
    });
  });

  test('reads the pagination text of the first and the last page', () => {
    expect(p1.countText).toBe('Du hast 30 von 235 Artikeln gesehen');
    expect(p8.countText).toBe('Du hast alle 235 Artikel gesehen');
  });

  test('a link that is not a URL is an unreadable box, naming it', () => {
    const parsed = parseCollectItPage(
      firstBoxOnly(($, box) => box.find('a[href]').attr('href', 'http://[')),
      null
    );
    expect(parsed).toMatchObject({ listings: [], productCount: 1, skippedInvalid: 1 });
    expect(parsed.firstSkipped).toContain('unreadable link "http://["');
  });

  test('skipped boxes give one warning per page, with the count', () => {
    const $ = cheerio.load(P1);
    $('#product-list .c-product-box .c-product-box-content-title').slice(0, 3).text('Sammelmappe');
    let parsed: CollectItPage | undefined;
    const warned = warnings(() => (parsed = parseCollectItPage($.html(), null)));
    expect(parsed?.skippedNoId).toBe(3);
    const skips = warned.filter((w) => w.includes('skipped'));
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain('3 product box(es)');
  });

  test('a very long title is clipped in what the parser reports', () => {
    const long = 'X'.repeat(5000);
    const parsed = parseCollectItPage(
      firstBoxOnly(($, box) => box.find('.c-product-box-content-title').text(long)),
      null
    );
    expect(parsed.firstSkipped!.length).toBeLessThan(500);
    expect(parsed.firstSkipped).toContain('…');
  });
});

describe('readArticleTotal', () => {
  test('reads both forms of the pagination text', () => {
    expect(readArticleTotal('Du hast 30 von 235 Artikeln gesehen')).toBe(235);
    expect(readArticleTotal('Du hast alle 235 Artikel gesehen')).toBe(235);
    expect(readArticleTotal('Du hast alle 1 Artikel gesehen')).toBe(1);
  });

  test('anything else is null', () => {
    expect(readArticleTotal('Du hast viele Artikel gesehen')).toBeNull();
    expect(readArticleTotal('')).toBeNull();
    expect(readArticleTotal('Du hast 30 von 235 Artikeln gesehen, danke')).toBeNull();
  });
});

describe('createCollectItFetcher', () => {
  const twoPages = () => ({
    Einzelkarten: asPage(P1, 1, true, 55),
    _s2: asPage(P8, 2, false, 55),
  });

  test('follows the next-page link and stops on the page without one', async () => {
    const { fetchFn, calls } = fakeFetch(twoPages());
    const sleeps: number[] = [];
    const adapter = createCollectItFetcher(SERIES_3, fetchFn, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(adapter.id).toBe('collect-it');
    const result = await adapter.fetchListings();
    expect(calls).toEqual([BASE, `${BASE}_s2`]);
    expect(sleeps).toEqual([1500]);
    // Any skipped box rejects, so a result carries no skipped counts.
    expect(Object.keys(result)).toEqual(['listings']);
    expect(result.listings).toHaveLength(55);
    expect(result.listings.some((l) => l.cardIds[0] === '12')).toBe(true);
    expect(result.listings.some((l) => l.cardIds[0] === 'LE20')).toBe(true);
  });

  test('a title whose card id cannot be read rejects, naming the title', async () => {
    const bad = firstBoxOnly(($, box) =>
      box.find('.c-product-box-content-title').text('Sammelmappe - Serie 3')
    );
    const error = await rejection({
      Einzelkarten: asPage(P1, 1, true),
      _s2: asPage(bad, 2, false),
    });
    expect(error.message).toContain('page 2');
    expect(error.message).toContain('"Sammelmappe - Serie 3"');
  });

  test('a product box without a link rejects, naming the box', async () => {
    const bad = firstBoxOnly(($, box) => box.find('a').removeAttr('href'));
    const error = await rejection({ Einzelkarten: asPage(bad, 1, false) });
    expect(error.message).toContain('page 1');
    expect(error.message).toContain('without a link');
  });

  test('a box with an unknown availability rejects, naming the value', async () => {
    const bad = firstBoxOnly(($, box) =>
      box.find('link[itemprop="availability"]').attr('href', 'https://schema.org/Banana')
    );
    const error = await rejection({ Einzelkarten: asPage(bad, 1, false) });
    expect(error.message).toContain('https://schema.org/Banana');
  });

  test('throws ShopLayoutError when page 1 is a bot wall', async () => {
    const { fetchFn } = fakeFetch({ Einzelkarten: '<html>Just a moment...</html>' });
    const error = await createCollectItFetcher(SERIES_3, fetchFn, { delayMs: 0 })
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
    const error = await createCollectItFetcher(SERIES_3, fetchFn, { delayMs: 0 })
      .fetchListings()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect((error as Error).message).toContain('page 2');
  });

  test('a single page whose only box has no card id rejects', async () => {
    const noCards = firstBoxOnly(($, box) =>
      box.find('.c-product-box-content-title').text('Sammelmappe - Serie 3')
    );
    const error = await rejection({ Einzelkarten: noCards });
    expect(error.message).toContain('1 unreadable product box(es)');
  });

  describe('article total and full pages', () => {
    test('page 1 without a next link rejects unless it holds every article', async () => {
      // collect-it dropping rel="next" must not read page 1 alone as the whole shop.
      const error = await rejection({ Einzelkarten: asPage(P1, 1, false) });
      expect(error.message).toContain('read 30 listings, but page 1 counts 235 articles');
    });

    test('a total that does not match the listings read rejects, naming both', async () => {
      const error = await rejection({
        Einzelkarten: asPage(P1, 1, true, 56),
        _s2: asPage(P8, 2, false, 56),
      });
      expect(error.message).toContain('read 55 listings, but page 1 counts 56 articles');
    });

    test('a card that sells out during the walk shifts the pages and rejects', async () => {
      // A card on page 1 sold out after page 1 was read, so page 2 shows one product fewer.
      const error = await rejection({
        Einzelkarten: asPage(P1, 1, true, 55),
        _s2: asPage(dropBoxes(P8, 1), 2, false, 55),
      });
      expect(error.message).toContain('read 54 listings, but page 1 counts 55 articles');
    });

    test('page 1 without the article count rejects', async () => {
      const error = await rejection({ Einzelkarten: withCountText(asPage(P1, 1, true), null) });
      expect(error.message).toContain('page 1 has no article count');
    });

    test('an unreadable article count rejects, quoting it', async () => {
      const error = await rejection({
        Einzelkarten: withCountText(asPage(P1, 1, true), 'Du hast viele Artikel gesehen'),
      });
      expect(error.message).toContain(
        'page 1 has an unreadable article count "Du hast viele Artikel gesehen"'
      );
    });

    test('a later page without the count is accepted', async () => {
      const { fetchFn } = fakeFetch({
        Einzelkarten: asPage(P1, 1, true, 55),
        _s2: withCountText(asPage(P8, 2, false), null),
      });
      const { listings } = await createCollectItFetcher(SERIES_3, fetchFn, {
        delayMs: 0,
      }).fetchListings();
      expect(listings).toHaveLength(55);
    });

    test('a later page with an unreadable count rejects', async () => {
      const error = await rejection({
        Einzelkarten: asPage(P1, 1, true, 55),
        _s2: withCountText(asPage(P8, 2, false), 'kaputt'),
      });
      expect(error.message).toContain('page 2 has an unreadable article count');
    });

    test('a later page with another total rejects', async () => {
      const error = await rejection({
        Einzelkarten: asPage(P1, 1, true, 55),
        _s2: asPage(P8, 2, false, 54),
      });
      expect(error.message).toContain('page 2 counts 54 articles, page 1 counted 55');
    });

    test('a page with a next link must be full (30 products)', async () => {
      const error = await rejection({
        Einzelkarten: asPage(dropBoxes(P1, 1), 1, true, 54),
        _s2: asPage(P8, 2, false, 54),
      });
      expect(error.message).toContain('page 1 has 29 products, but links a next page');
    });

    test('the saved first and last page pass both checks', () => {
      for (const [html, hasNext] of [
        [P1, true],
        [P8, false],
      ] as const) {
        const parsed = parseCollectItPage(html, null);
        expect(readArticleTotal(parsed.countText!)).toBe(235);
        if (hasNext) expect(parsed.productCount).toBe(30);
        else expect(parsed.productCount).toBeLessThanOrEqual(30);
      }
    });
  });

  test('a very long canonical link is clipped in the error', async () => {
    const href = `${BASE}?${'x'.repeat(5000)}`;
    const error = await rejection({ Einzelkarten: withCanonical(asPage(P1, 1, false), href) });
    expect(error.message.length).toBeLessThan(400);
    expect(error.message).toContain('…');
  });

  test('a failed page is not logged by the adapter (the runner logs it once)', async () => {
    const log = spyOn(logger, 'log');
    try {
      const { fetchFn } = fakeFetch({ Einzelkarten: '<html>Just a moment...</html>' });
      await createCollectItFetcher(SERIES_3, fetchFn, { delayMs: 0 })
        .fetchListings()
        .catch(() => undefined);
      expect(log.mock.calls.filter((c) => c[0] === 'error')).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  test('a network error names the page that failed and keeps the cause', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    const fetchFn = async (url: string) => {
      if (url.endsWith('_s2')) throw timeout;
      return new Response(asPage(P1, 1, true));
    };
    const error = (await createCollectItFetcher(SERIES_3, fetchFn, { delayMs: 0 })
      .fetchListings()
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('collect-it: page 2 failed: The operation timed out.');
    expect(error.cause).toBe(timeout);
  });

  test('the same product URL on two pages counts once', async () => {
    const { fetchFn } = fakeFetch({
      Einzelkarten: asPage(P1, 1, true, 30),
      _s2: asPage(P1, 2, false, 30),
    });
    const { listings } = await createCollectItFetcher(SERIES_3, fetchFn, {
      delayMs: 0,
    }).fetchListings();
    expect(listings).toHaveLength(30);
    expect(new Set(listings.map((l) => l.url)).size).toBe(30);
  });

  test('an HTTP error rejects', async () => {
    const { fetchFn } = fakeFetch({});
    await expect(
      createCollectItFetcher(SERIES_3, fetchFn, { delayMs: 0 }).fetchListings()
    ).rejects.toThrow('HTTP 404');
  });

  test('a linked page that answers as another page rejects instead of ending the walk', async () => {
    // The shop shrank between two requests: page 2 redirects to page 1, which links page 2.
    const error = await rejection({ Einzelkarten: asPage(P1, 1, true), _s2: P1 });
    expect(error.message).toContain('asked for page 2');
    expect(error.message).toContain('page 1');
  });

  test('rejects at the page cap after exactly 60 requests', async () => {
    // Every page answers as the page that was asked for, and always links one more.
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(url);
      const n = Number(/_s(\d+)$/.exec(url)?.[1] ?? '1');
      return new Response(asPage(P1, n, true));
    };
    const error = await createCollectItFetcher(SERIES_3, fetchFn, { delayMs: 0 })
      .fetchListings()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect((error as Error).message).toContain('60 pages');
    expect(calls).toHaveLength(60);
    expect(calls[59]).toBe(`${BASE}_s60`);
  }, 30_000);

  test('a later page without a canonical link rejects', async () => {
    const error = await rejection({
      Einzelkarten: asPage(P1, 1, true),
      _s2: withCanonical(asPage(P8, 2, false), null),
    });
    expect(error.message).toContain('page 2 has no canonical link');
  });

  test('page 1 without a canonical link rejects with that reason', async () => {
    const error = await rejection({ Einzelkarten: withCanonical(asPage(P1, 1, false), null) });
    expect(error.message).toContain('page 1 has no canonical link');
  });

  test('page 1 whose canonical link names another page rejects with that reason', async () => {
    const error = await rejection({
      Einzelkarten: withCanonical(asPage(P1, 1, false), `${BASE}_s3`),
    });
    expect(error.message).toContain('asked for page 1, got page 3');
  });

  for (const [format, href] of [
    ['a trailing slash', `${BASE}/`],
    ['a query', `${BASE}?sort=price`],
    ['a fragment', `${BASE}#top`],
    ['a relative path', '/sammelkarten/lego/minecraft/serie-3/Einzelkarten'],
    [
      'another category',
      'https://www.collect-it.de/sammelkarten/lego/minecraft/serie-2/Einzelkarten',
    ],
    ['another host', 'https://collect-it.example/sammelkarten/lego/minecraft/serie-3/Einzelkarten'],
    ['a page suffix with a trailing slash', `${BASE}_s2/`],
    ['page 0', `${BASE}_s0`],
    ['a leading zero in the page suffix', `${BASE}_s02`],
    ['an empty query', `${BASE}?`],
    ['an empty fragment', `${BASE}#`],
  ] as const) {
    test(`a canonical link with ${format} is unreadable and rejects`, async () => {
      const error = await rejection({ Einzelkarten: withCanonical(asPage(P1, 1, false), href) });
      expect(error.message).toContain('unreadable canonical link');
      expect(error.message).toContain(href);
    });
  }

  test('follows the next-page href, resolved against the category URL', async () => {
    const { fetchFn, calls } = fakeFetch({
      Einzelkarten: withNext(
        asPage(P1, 1, true, 55),
        '/sammelkarten/lego/minecraft/serie-3/Einzelkarten_s2'
      ),
      _s2: asPage(P8, 2, false, 55),
    });
    const { listings } = await createCollectItFetcher(SERIES_3, fetchFn, {
      delayMs: 0,
    }).fetchListings();
    expect(calls).toEqual([BASE, `${BASE}_s2`]);
    expect(listings).toHaveLength(55);
  });

  for (const href of [`${BASE}_s2?a=1`, `${BASE}_s2?`, `${BASE}_s2#`, `${BASE}_s02`]) {
    test(`an unreadable next-page href ${href.slice(BASE.length)} rejects`, async () => {
      const error = await rejection({ Einzelkarten: withNext(asPage(P1, 1, true), href) });
      expect(error.message).toContain(`unreadable next-page link "${href}"`);
    });
  }

  test('a next-page href that skips a page rejects', async () => {
    const error = await rejection({
      Einzelkarten: withNext(asPage(P1, 1, true), `${BASE}_s3`),
      _s3: asPage(P8, 3, false),
    });
    expect(error.message).toContain('page 1 links page 3 as the next page');
  });
});

describe('series 1', () => {
  const S1 = readFixture('collect-it-serie-1-p1.html');
  /** The saved series 1 page as the whole category: no next page, its 30 boxes the total. */
  const alone = (html: string) => {
    const $ = cheerio.load(html);
    $('link[rel="next"], link[rel="prev"]').remove();
    $('.ci-pagination-meta').html('Du hast <strong>alle 30</strong> Artikel gesehen');
    return $.html();
  };
  /** `html` with the first product box titled `to` (it was `from`). */
  const retitle = (html: string, from: string, to: string) => {
    const $ = cheerio.load(html);
    const title = $('.c-product-box-content-title').first();
    expect(title.text().replace(/\s+/g, ' ').trim()).toBe(from);
    title.text(to);
    return $.html();
  };

  test('the series 1 category walks its own pages', async () => {
    const { fetchFn, calls } = fakeFetch({ Einzelkarten: alone(S1) });
    const { listings } = await createCollectItFetcher(SERIES_1, fetchFn, {
      delayMs: 0,
    }).fetchListings();
    expect(calls).toEqual([SERIES_1.category]);
    expect(listings).toHaveLength(30);
    expect(listings[0]).toMatchObject({
      cardIds: [cid('1')],
      title: '1 - Steve - Skin Karte - Serie 1',
    });
  });

  test('an item of another series in the category is skipped and counted', async () => {
    const html = retitle(
      alone(S1),
      '1 - Steve - Skin Karte - Serie 1',
      '1 - Steve - Skin Karte - Serie 3'
    );
    const { fetchFn } = fakeFetch({ Einzelkarten: html });
    const result = await createCollectItFetcher(SERIES_1, fetchFn, { delayMs: 0 }).fetchListings();
    expect(result.listings).toHaveLength(29);
    expect(result.skippedExcluded).toBe(1);
    expect(result.listings.map((l) => l.cardIds[0])).not.toContain(cid('1'));
  });

  test('"XXL 1 - …" reads as XXL1', () => {
    const html = retitle(
      S1,
      '1 - Steve - Skin Karte - Serie 1',
      'XXL 1 - Explodierender Creeper - Oversize Karte - Serie 1'
    );
    const page = parseCollectItPage(html, 'Serie 1');
    expect(page.listings.map((l) => l.cardIds[0])).toContain(cid('XXL1'));
  });

  test('a title without the series label is an unreadable box: the walk fails, nothing is marked sold out', async () => {
    const html = retitle(alone(S1), '1 - Steve - Skin Karte - Serie 1', '1 - Steve - Skin Karte');
    const { fetchFn } = fakeFetch({ Einzelkarten: html });
    await expect(
      createCollectItFetcher(SERIES_1, fetchFn, { delayMs: 0 }).fetchListings()
    ).rejects.toThrow(/unreadable product box.*no series label/);
  });

  test('a category of only other series is a shop error, not 0 listings', async () => {
    const { fetchFn } = fakeFetch({ Einzelkarten: alone(S1) });
    const wrong = { ...SERIES_1, series: 'Serie 2' };
    await expect(
      createCollectItFetcher(wrong, fetchFn, { delayMs: 0 }).fetchListings()
    ).rejects.toThrow('collect-it: no card listings of Serie 2 found');
  });

  test('the series label is compared by its number', () => {
    const html = retitle(
      S1,
      '1 - Steve - Skin Karte - Serie 1',
      '1 - Steve - Skin Karte - Serie 01'
    );
    expect(parseCollectItPage(html, 'Serie 1').listings.map((l) => l.cardIds[0])).toContain(
      cid('1')
    );
  });

  test('a URL read as this series on one page is not also counted as another series later', async () => {
    const $1 = cheerio.load(P1);
    const repeated = $1('.c-product-box-content a[href]').first().attr('href')!;
    const $8 = cheerio.load(P8);
    const box = $8('.c-product-box').first();
    box.find('.c-product-box-content a[href]').attr('href', repeated);
    box.find('.c-product-box-content-title').text('1 - Alex - Charakterkarte - Serie 2');
    const unique = 30 + $8('.c-product-box').length - 1;
    const { fetchFn } = fakeFetch({
      Einzelkarten_s2: asPage($8.html(), 2, false, unique),
      Einzelkarten: asPage(P1, 1, true, unique),
    });
    const result = await createCollectItFetcher(SERIES_3, fetchFn, { delayMs: 0 }).fetchListings();
    expect(result.listings).toHaveLength(unique);
    expect(result.skippedExcluded).toBeUndefined();
  });
});

describe('Turbo Attax 2026', () => {
  const TA = turboAttax2026.shops['collect-it']!;
  const TA_P1 = readFixture('collect-it-turbo-attax-p1.html');
  const TA_P10 = readFixture('collect-it-turbo-attax-p10.html');

  test('the definition reads the Turbo Attax category with the year as its series label', () => {
    expect(TA).toEqual({
      category:
        'https://www.collect-it.de/sammelkarten/formel1/Topps-Turbo-Attax-Formel-1-2026/Einzelkarten',
      series: '2026',
    });
    expect(sameSeries('2026', '2026')).toBe(true);
    expect(sameSeries('2026', 'Serie 2')).toBe(false);
  });

  test("page 1 reads every card with Turbo Attax's rule, nothing skipped", () => {
    const page = parseCollectItPage(TA_P1, '2026', TURBO_ATTAX_CARD_IDS);
    expect(page.listings).toHaveLength(30);
    expect(page.skippedNoId + page.skippedInvalid).toBe(0);
    expect(page.excluded).toEqual([]);
    expect(page.listings[0]).toMatchObject({
      cardIds: [cid('1')],
      cardName: 'Team Logo McLaren Mastercard',
      title: '1 - Team Logo McLaren Mastercard - 2026',
      available: true,
    });
    expect(page.listings[2]).toMatchObject({
      cardIds: [cid('3')],
      cardName: 'Lando Norris / Oscar Piastri',
    });
    expect(page.countText).toBe('Du hast 30 von 303 Artikeln gesehen');
  });

  test('page 10 reads the Greats of the Grid and relic codes', () => {
    const page = parseCollectItPage(TA_P10, '2026', TURBO_ATTAX_CARD_IDS);
    expect(page.listings).toHaveLength(30);
    expect(page.skippedNoId + page.skippedInvalid).toBe(0);
    const byId = new Map(page.listings.map((l) => [l.cardIds[0], l]));
    expect(byId.get(cid('GG8'))?.cardName).toBe('Michael Schumacher');
    expect(byId.get(cid('MR-HAM'))?.cardName).toBe('Lewis Hamilton');
    expect(byId.get(cid('344'))?.cardName).toBe('George Russell');
  });

  test('a year label in a Minecraft category, or a Serie label in Turbo Attax, is no series label', () => {
    const minecraft = parseCollectItPage(TA_P1, 'Serie 1', MINECRAFT_CARD_IDS);
    expect(minecraft.listings).toEqual([]);
    expect(minecraft.excluded).toEqual([]);
    expect(minecraft.skippedNoId).toBe(30);
    expect(minecraft.firstSkipped).toContain('no series label');
    const turbo = parseCollectItPage(
      readFixture('collect-it-serie-1-p1.html'),
      '2026',
      TURBO_ATTAX_CARD_IDS
    );
    expect(turbo.listings).toEqual([]);
    expect(turbo.excluded).toEqual([]);
    expect(turbo.skippedNoId).toBe(30);
  });

  test('another year in the Turbo Attax category is another series; one such box is counted', () => {
    const $ = cheerio.load(TA_P1);
    $('.c-product-box-content-title').first().text('1 - Team Logo McLaren Mastercard - 2025');
    const page = parseCollectItPage($.html(), '2026', TURBO_ATTAX_CARD_IDS);
    expect(page.listings).toHaveLength(29);
    expect(page.excluded).toHaveLength(1);
    expect(page.skippedNoId).toBe(0);
  });

  test('one year-labelled box in a Minecraft category fails the walk instead of reading as sold out', async () => {
    const S1 = readFixture('collect-it-serie-1-p1.html');
    const $ = cheerio.load(S1);
    $('link[rel="next"], link[rel="prev"]').remove();
    $('.ci-pagination-meta').html('Du hast <strong>alle 30</strong> Artikel gesehen');
    $('.c-product-box-content-title').first().text('1 - Steve - Skin Karte - 2026');
    const { fetchFn } = fakeFetch({ Einzelkarten: $.html() });
    const series1 = legoMinecraft1.shops['collect-it']!;
    await expect(
      createCollectItFetcher(series1, fetchFn, { delayMs: 0 }).fetchListings()
    ).rejects.toThrow(/unreadable product box.*no series label/);
  });

  test('another series is read before the card id: a foreign id form is excluded, not unreadable', () => {
    const $ = cheerio.load(readFixture('collect-it-serie-1-p1.html'));
    $('.c-product-box-content-title').first().text('GG8 - Michael Schumacher - Serie 3');
    const page = parseCollectItPage($.html(), 'Serie 1', MINECRAFT_CARD_IDS);
    expect(page.excluded).toHaveLength(1);
    expect(page.skippedNoId).toBe(0);
  });

  test('a first title part that is no card id form is no card id, also when the rule would read it', () => {
    const $ = cheerio.load(readFixture('collect-it-serie-1-p1.html'));
    $('.c-product-box-content-title').first().text('#1 - Steve - Skin Karte - Serie 1');
    const page = parseCollectItPage($.html(), 'Serie 1', MINECRAFT_CARD_IDS);
    expect(page.skippedNoId).toBe(1);
    expect(page.firstSkipped).toContain('no card id');
  });

  test("the fetcher reads with the collection's rule", async () => {
    const $ = cheerio.load(TA_P10);
    $('link[rel="next"], link[rel="prev"]').remove();
    $('link[rel="canonical"]').attr('href', TA.category);
    $('.ci-pagination-meta').html('Du hast <strong>alle 30</strong> Artikel gesehen');
    const { fetchFn } = fakeFetch({ Einzelkarten: $.html() });
    const { listings } = await createCollectItFetcher(
      TA,
      fetchFn,
      { delayMs: 0 },
      TURBO_ATTAX_CARD_IDS
    ).fetchListings();
    expect(listings.map((l) => l.cardIds[0])).toContain(cid('MR-HAM'));
    expect(listings).toHaveLength(30);
  });
});
