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
import { HttpError } from '../utils/http';

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

  test('a year or other four-digit tail is no card id; a prefix the rule does not know is a name', () => {
    expect(
      slugCardId(product('lando-norris-2026'), TURBO_ATTAX_CARD_IDS, SETTINGS.slugSuffix)
    ).toBeNull();
    expect(
      slugCardId(product('x-le-1-turbo-attax-f1-2026'), TURBO_ATTAX_CARD_IDS, SETTINGS.slugSuffix)
    ).toBeNull();
  });

  test('a slug without a trailing card id reads nothing; an unknown prefix leaves the number', () => {
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

  test('the link text, when not cut, must name the same card as the slug', () => {
    const $ = cheerio.load(P1);
    const a = $('.product-miniature').eq(3).find('.product-title a').first();
    expect(a.text().trim()).toBe('Lando Norris 2026 F1 Hero 4');
    a.text('Lando Norris 2026 F1 Hero 5');
    const page = read($.html());
    expect(page.skipped).toBe(1);
    expect(page.firstSkipped).toContain('names another card than its link');
  });

  test("an F1 Car text checks its number too: Car 184 is no card of another slug's", () => {
    const $ = cheerio.load(P1);
    const a = $('.product-miniature').eq(3).find('.product-title a');
    a.first().text('Kimi Antonelli 2026 F1 Car 184');
    const page = read($.html());
    expect(page.skipped).toBe(1);
    expect(page.firstSkipped).toContain('names another card than its link');
  });

  test('the title is the uncut link text without its id, else the alt text without shop words', () => {
    const page = read(P1);
    expect(page.listings[3]!.title).toBe('Lando Norris 2026 F1 Hero');
    const $ = cheerio.load(P1);
    const box = $('.product-miniature').eq(3);
    box.find('.product-title a').first().text('Lando Norris 2026 F1...');
    box
      .find('img')
      .attr('alt', 'Get yours Lando Norris Power In Numbers Cards Turbo Attax F1 2026');
    expect(read($.html()).listings[3]!.title).toBe('Lando Norris Power In Numbers');
  });

  test('a query or fragment on a product link is dropped from the stored URL', () => {
    const $ = cheerio.load(P1);
    const a = $('.product-miniature').first().find('.product-title a');
    a.attr('href', `${a.attr('href')}?utm_source=x#/1-size-s`);
    expect(read($.html()).listings[0]!.url).toBe(
      product('mclaren-mastercard-formula-1-team-f1-team-logos-1')
    );
  });

  test('a box without a readable price, or with stock links that disagree, is unreadable', () => {
    const $ = cheerio.load(P1);
    $('.product-miniature').first().find('[itemprop="price"]').attr('content', '1,50');
    $('.product-miniature').eq(1).find('[itemprop="price"]').remove();
    $('.product-miniature')
      .eq(2)
      .append('<link itemprop="availability" href="http://schema.org/OutOfStock">');
    const page = read($.html());
    expect(page.skipped).toBe(3);
    expect(page.firstSkipped).toContain('price');
  });

  test('a cut link text takes the alt text without its shop words; a picture without a large size uses src', () => {
    const $ = cheerio.load(P1);
    const img = $('.product-miniature').first().find('img');
    img.attr(
      'alt',
      'Buy Cards online McLaren Mastercard Formula 1 Team F1 Team Logos Topps Formula 1 Turbo Attax 2026'
    );
    img.removeAttr('data-full-size-image-url');
    const first = read($.html()).listings[0]!;
    expect(first.title).toBe('McLaren Mastercard Formula 1 Team F1 Team Logos');
    expect(first.imageUrl).toBe(
      'https://www.euro-soccer-cards.com/184504-home_default/mclaren-mastercard-formula-1-team-f1-team-logos-1.jpg'
    );
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
  test('walks rel="next", 1500 ms between pages, and reads exactly the total', async () => {
    const { fetchFn, calls } = twoPages();
    const sleeps: number[] = [];
    const result = await createEuroSoccerCardsFetcher(
      SETTINGS,
      fetchFn,
      { sleep: async (ms) => void sleeps.push(ms) },
      TURBO_ATTAX_CARD_IDS
    ).fetchListings();
    expect(sleeps).toEqual([1500]);
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
    [
      'a canonical link missing',
      { p2: (html: string) => html.replace(/<link rel="canonical"[^>]*>/, '') },
      'page 2 has no canonical link',
    ],
  ] as const)('%s is a ShopLayoutError', async (_name, over, message) => {
    const { fetchFn } = twoPages(over);
    const error = await fetchAll(fetchFn).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect(String(error)).toContain(message);
  });

  test('a next link naming another page, or a short page linking one, is a ShopLayoutError', async () => {
    const wrongNext = cheerio.load(P1);
    wrongNext('link[rel="next"]').attr('href', `${CATEGORY}?page=3`);
    const e1 = await fetchAll(fakeFetch({ [CATEGORY]: wrongNext.html() }).fetchFn).catch(
      (e: unknown) => e
    );
    expect(String(e1)).toContain('page 1 links page 3 as the next page');
    const short = cheerio.load(P1);
    short('.product-miniature').last().remove();
    const e2 = await fetchAll(fakeFetch({ [CATEGORY]: short.html() }).fetchFn).catch(
      (e: unknown) => e
    );
    expect(String(e2)).toContain('page 1 has 35 products, but links a next page');
  });

  test('a product on two pages counts once, so the total no longer matches', async () => {
    const { fetchFn } = twoPages({
      total: 68,
      p2: () => {
        const $ = cheerio.load(P11);
        const firstOfP1 = cheerio.load(P1)('.product-miniature').first();
        $('.product-miniature').first().replaceWith(firstOfP1);
        return $.html();
      },
    });
    const error = await fetchAll(fetchFn).catch((e: unknown) => e);
    expect(String(error)).toContain('read 67 products, but page 1 counts 68');
  });

  test('an HTTP error on page 2 rejects with it, nothing returned', async () => {
    const { fetchFn } = twoPages();
    const failing: typeof fetchFn = async (url, init) =>
      url.endsWith('?page=2') ? new Response('busy', { status: 503 }) : fetchFn(url, init);
    await expect(fetchAll(failing)).rejects.toBeInstanceOf(HttpError);
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
      Array.from({ length: 36 }, (_, i) => box((page % 20) * 36 + i + 1)).join('') +
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
