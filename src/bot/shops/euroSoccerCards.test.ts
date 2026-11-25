import { describe, expect, test } from 'bun:test';
import * as cheerio from 'cheerio';
import { MINECRAFT_CARD_IDS, TURBO_ATTAX_CARD_IDS } from '../cards/cardId';
import { turboAttax2026 } from '../collections/turboAttax2026';
import { cid } from '../../test/cardIds';
import { fakeFetch, readFixture } from '../../test/shopHelpers';
import {
  createEuroSoccerCardsFetcher,
  euroSoccerCardsPageNumber,
  parseEuroSoccerCardsPage,
  slugCardId,
} from './euroSoccerCards';
import { ShopLayoutError } from './types';

const SETTINGS = turboAttax2026.shops['euro-soccer-cards']!;
const CATEGORY = SETTINGS.category;
const P1 = readFixture('euro-soccer-cards-p1.html');
const P11 = readFixture('euro-soccer-cards-p11.html');
const product = (slug: string) => `${CATEGORY}${slug}`;

/** Page 11 as page 2 of a two-page walk of 68 products (page 1's 36 and its 32). */
function twoPages(
  over: { total?: number; canonical2?: string; p2?: (html: string) => string } = {}
) {
  const $1 = cheerio.load(P1);
  $1('.total-products').text(`There are ${over.total ?? 68} products.`);
  const $2 = cheerio.load(over.p2 ? over.p2(P11) : P11);
  $2('link[rel="canonical"]').attr('href', over.canonical2 ?? `${CATEGORY}?page=2`);
  return fakeFetch({ '?page=2': $2.html(), [CATEGORY]: $1.html() });
}

const fetchAll = (fetchFn: Parameters<typeof createEuroSoccerCardsFetcher>[1]) =>
  createEuroSoccerCardsFetcher(
    SETTINGS,
    fetchFn,
    { delayMs: 0 },
    TURBO_ATTAX_CARD_IDS
  ).fetchListings();

describe('euro-soccer-cards settings', () => {
  test('Turbo Attax reads its English category, ids from the URL slug', () => {
    expect(SETTINGS).toEqual({
      category: 'https://www.euro-soccer-cards.com/gb/topps-turbo-attax-2026/',
      slugSuffix: '-turbo-attax-2026',
    });
  });
});

describe('slugCardId', () => {
  test.each([
    ['mclaren-mastercard-formula-1-team-f1-team-logos-1', '1'],
    ['mark-webber-legends-of-the-grid-150-turbo-attax-2026', '150'],
    ['oscar-piastri-guardians-of-the-grid-gu-1-turbo-attax-2026', 'GU1'],
    ['lando-norris-2026-f1-car-184-turbo-attax-2026', '184'],
    ['oscar-piastri-limited-edition-le-1-turbo-attax-2026', 'LE1'],
    ['lewis-hamilton-manufactured-relic-mr-ham-turbo-attax-2026', 'MR-HAM'],
  ])('%s is %s', (slug, id) => {
    expect(slugCardId(product(slug), TURBO_ATTAX_CARD_IDS, SETTINGS.slugSuffix)).toBe(cid(id));
  });

  test('a slug without a trailing card id, or a prefix of another rule, reads nothing', () => {
    expect(slugCardId(product('mclaren-team-logos'), TURBO_ATTAX_CARD_IDS, '')).toBeNull();
    expect(slugCardId(product('x-gu-1'), MINECRAFT_CARD_IDS, '')).toBe(cid('1'));
    expect(slugCardId(product('x-gu-0'), TURBO_ATTAX_CARD_IDS, '')).toBeNull();
  });
});

describe('euroSoccerCardsPageNumber', () => {
  test('page 1 is the category, page N its ?page=N; anything else is unreadable', () => {
    expect(euroSoccerCardsPageNumber(CATEGORY, CATEGORY)).toBe(1);
    expect(euroSoccerCardsPageNumber(`${CATEGORY}?page=11`, CATEGORY)).toBe(11);
    expect(euroSoccerCardsPageNumber(`${CATEGORY}?page=1`, CATEGORY)).toBeNull();
    expect(euroSoccerCardsPageNumber(`${CATEGORY}?page=2&order=x`, CATEGORY)).toBeNull();
    expect(
      euroSoccerCardsPageNumber(
        'https://www.euro-soccer-cards.com/es/topps-turbo-attax-2026/',
        CATEGORY
      )
    ).toBeNull();
  });
});

describe('parseEuroSoccerCardsPage', () => {
  const read = (html: string) => parseEuroSoccerCardsPage(html, SETTINGS, TURBO_ATTAX_CARD_IDS);

  test('page 1: 36 cards, the total, the next page', () => {
    const page = read(P1);
    expect(page.listings).toHaveLength(36);
    expect(page.skipped).toBe(0);
    expect(page.total).toBe(392);
    expect(page.next).toBe(`${CATEGORY}?page=2`);
    expect(page.canonical).toBe(CATEGORY);
    expect(page.listings[0]).toMatchObject({
      shop: 'euro-soccer-cards',
      url: product('mclaren-mastercard-formula-1-team-f1-team-logos-1'),
      title: 'McLaren Mastercard Formula 1 Team F1 Team Logos',
      cardIds: [cid('1')],
      price: { cents: 150, currency: 'EUR' },
      available: true,
      format: 'shop',
      imageUrl:
        'https://www.euro-soccer-cards.com/184504-large_default/mclaren-mastercard-formula-1-team-f1-team-logos-1.jpg',
    });
  });

  test('page 11: the limited editions, sold-out boxes unavailable, no next page', () => {
    const page = read(P11);
    expect(page.listings).toHaveLength(32);
    expect(page.skipped).toBe(0);
    expect(page.next).toBeNull();
    const byId = new Map(page.listings.map((l) => [l.cardIds[0], l]));
    expect(byId.get(cid('LE1'))?.available).toBe(true);
    expect(byId.get(cid('LE3'))?.available).toBe(false);
    expect(byId.get(cid('BG1'))).toBeDefined();
    expect(byId.get(cid('GG8'))).toBeDefined();
  });

  test('a box without a readable id or availability is skipped and named', () => {
    const $ = cheerio.load(P1);
    $('.product-miniature')
      .first()
      .find('link[itemprop="availability"]')
      .attr('href', 'https://schema.org/Maybe');
    $('.product-miniature').eq(1).find('.product-title a').attr('href', product('team-logos'));
    const page = read($.html());
    expect(page.listings).toHaveLength(34);
    expect(page.skipped).toBe(2);
    expect(page.firstSkipped).toContain('availability');
  });

  test('a product link outside the category is skipped', () => {
    const $ = cheerio.load(P1);
    const link = (n: number) => $('.product-miniature').eq(n).find('.product-title a');
    link(0).attr('href', 'https://other.example/x-1');
    link(1).attr('href', `${CATEGORY}sub/x-2`);
    link(2).attr('href', 'https://www.euro-soccer-cards.com/es/topps-turbo-attax-2026/x-3');
    const page = read($.html());
    expect(page.skipped).toBe(3);
    expect(page.firstSkipped).toContain('outside the category');
  });

  test('a page that is no category page has no boxes and no total', () => {
    const page = read('<html><body>Just a moment...</body></html>');
    expect(page.listings).toEqual([]);
    expect(page.productCount).toBe(0);
    expect(page.total).toBeNull();
  });
});

describe('createEuroSoccerCardsFetcher', () => {
  test('walks rel="next" and reads exactly the total', async () => {
    const { fetchFn, calls } = twoPages();
    const result = await fetchAll(fetchFn);
    expect(calls).toEqual([CATEGORY, `${CATEGORY}?page=2`]);
    expect(result.listings).toHaveLength(68);
    expect(result.listings.filter((l) => !l.available).length).toBeGreaterThan(0);
  });

  test.each([
    ['a total the walk does not read', { total: 69 }, 'read 68 products, but page 1 counts 69'],
    [
      'a canonical naming another page',
      { canonical2: `${CATEGORY}?page=3` },
      'asked for page 2, got page 3',
    ],
    [
      'an unreadable box',
      {
        p2: (html: string) => {
          const $ = cheerio.load(html);
          $('.product-miniature').first().find('link[itemprop="availability"]').remove();
          return $.html();
        },
      },
      'unreadable product box',
    ],
  ] as const)('%s is a ShopLayoutError', async (_name, over, message) => {
    const { fetchFn } = twoPages(over);
    const error = await fetchAll(fetchFn).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect(String(error)).toContain(message);
  });

  test('page 1 without a total, a page without boxes and the page cap are ShopLayoutErrors', async () => {
    const $ = cheerio.load(P1);
    $('.total-products').remove();
    const noTotal = await fetchAll(fakeFetch({ [CATEGORY]: $.html() }).fetchFn).catch(
      (e: unknown) => e
    );
    expect(String(noTotal)).toContain('page 1 has no product total');
    const empty = await fetchAll(
      fakeFetch({ [CATEGORY]: '<html>maintenance</html>' }).fetchFn
    ).catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(ShopLayoutError);
    expect(String(empty)).toContain('page 1 has no products');
    // Every page links a next one: the cap ends the walk (small pages of 36 boxes, fast to parse).
    const box = (n: number) =>
      `<article class="product-miniature"><h2 class="product-title"><a href="${CATEGORY}card-${n}">x</a></h2>` +
      `<span itemprop="price" content="1.00"></span><link itemprop="availability" href="http://schema.org/InStock"></article>`;
    const synthetic = (page: number) =>
      `<html><head><link rel="canonical" href="${page === 1 ? CATEGORY : `${CATEGORY}?page=${page}`}">` +
      `<link rel="next" href="${CATEGORY}?page=${page + 1}"></head><body>` +
      `<div class="total-products">There are 9999 products.</div>` +
      Array.from({ length: 36 }, (_, i) => box(page * 100 + i + 1)).join('') +
      '</body></html>';
    const capped = await createEuroSoccerCardsFetcher(
      SETTINGS,
      async (url) => new Response(synthetic(Number(new URL(url).searchParams.get('page') ?? '1'))),
      { delayMs: 0 },
      TURBO_ATTAX_CARD_IDS
    )
      .fetchListings()
      .catch((e: unknown) => e);
    expect(capped).toBeInstanceOf(ShopLayoutError);
    expect(String(capped)).toContain('still a next page after 40 pages');
  });
});
