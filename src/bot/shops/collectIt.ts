import * as cheerio from 'cheerio';
import { normalizeCardId } from '../cards/cardId';
import { sleep as realSleep } from '../utils/async';
import { fetchText } from '../utils/http';
import logger, { logError } from '../utils/logger';
import type { AdapterOptions, FetchFn, FetchResult, Listing, ShopAdapter } from './types';
import { ShopLayoutError } from './types';

const BASE_URL = 'https://www.collect-it.de/sammelkarten/lego/minecraft/serie-3/Einzelkarten';
const PAGE_DELAY_MS = 1500;
const MAX_PAGES = 60;
const BOX = '#product-list .c-product-box';

// "12 - Squid - Charakterkarte - Serie 3" -> id "12", name "Squid";
// "LE01 - Ender Dragon - Limitierte Karte - Serie 3" -> id "LE1" (canonical, normalizeCardId).
const TITLE_PATTERN = /^((?:LE|XXL)?\d+) - (.+?)(?: - |$)/i;
// schema.org ItemAvailability values, lowercased, and whether each means "can be ordered now".
const AVAILABILITY = new Map<string, boolean>([
  ['instock', true],
  ['limitedavailability', true],
  ['onlineonly', true],
  ['outofstock', false],
  ['soldout', false],
  ['discontinued', false],
  ['backorder', false],
  ['preorder', false],
  ['presale', false],
  ['madetoorder', false],
  ['instoreonly', false],
  ['reserved', false],
]);
// `https://schema.org/InStock`, `http://schema.org/InStock` or a bare `InStock`.
const AVAILABILITY_VALUE = /^(?:(?:https?:)?\/\/(?:www\.)?schema\.org\/)?([a-z]+)$/i;

/** Whether an availability href means in stock; null when it is not a known schema.org value. */
function readAvailability(href: string): boolean | null {
  const tail = AVAILABILITY_VALUE.exec(href.trim())?.[1]?.toLowerCase();
  return tail === undefined ? null : (AVAILABILITY.get(tail) ?? null);
}

const BASE = new URL(BASE_URL);
const PAGE_SUFFIX = /^_s([1-9]\d*)$/;

/**
 * The page number a category URL names: exactly `BASE_URL` is page 1, `BASE_URL` plus `_sN`
 * page N. Anything else (another host or path, a trailing slash, a query or fragment, a
 * relative href when no base is given, `_s0`) is null: the walk cannot trust it.
 */
export function categoryPageNumber(href: string, base?: string): number | null {
  const url = URL.parse(href, base);
  if (!url || url.origin !== BASE.origin || url.search !== '' || url.hash !== '') return null;
  // `URL` drops an empty `?` or `#`; the raw href must not carry one either.
  if (/[?#]/.test(href)) return null;
  if (url.pathname === BASE.pathname) return 1;
  if (!url.pathname.startsWith(BASE.pathname)) return null;
  const suffix = PAGE_SUFFIX.exec(url.pathname.slice(BASE.pathname.length));
  return suffix ? Number.parseInt(suffix[1] ?? '', 10) : null;
}

function parsePrice(amount: string | undefined, currency: string | undefined): Listing['price'] {
  if (!amount || !/^\d+(?:\.\d{1,2})?$/.test(amount)) return null;
  return { cents: Math.round(Number.parseFloat(amount) * 100), currency: currency || 'EUR' };
}

/**
 * Parse one category page. `productCount` counts every product box of the listing grid;
 * `skippedNoId` counts boxes whose title does not start with a card number (the category holds
 * only singles, so any such title is parser drift), `skippedInvalid` boxes without a link, a
 * title or a known schema.org availability; `firstSkipped` describes the first skipped box
 * (null when none was). The adapter rejects a page with any skipped box. `canonical` and `next` are the raw hrefs of `<link rel="canonical">` and
 * `<link rel="next">` (null when absent); the adapter checks them with `categoryPageNumber`.
 */
export function parseCollectItPage(html: string): {
  listings: Listing[];
  productCount: number;
  canonical: string | null;
  next: string | null;
  skippedNoId: number;
  skippedInvalid: number;
  firstSkipped: string | null;
} {
  const $ = cheerio.load(html);
  const listings: Listing[] = [];
  let skippedNoId = 0;
  let skippedInvalid = 0;
  let firstSkipped: string | null = null;
  const skip = (what: string): void => {
    logger.warn(`collect-it: skipping ${what}`);
    firstSkipped ??= what;
  };

  const boxes = $(BOX);
  boxes.each((index, el) => {
    const box = $(el);
    const title = box
      .find('.c-product-box-content-title')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    const href = box.find('.c-product-box-content a[href]').first().attr('href');
    if (!href || !title) {
      skip(
        href
          ? `a product box without a title (${href})`
          : `a product box without a link (${title ? `"${title}"` : `box ${index + 1}`})`
      );
      skippedInvalid++;
      return;
    }
    const match = TITLE_PATTERN.exec(title);
    const cardId = match ? normalizeCardId(match[1] ?? '') : null;
    if (!match || !cardId) {
      skip(`"${title}" (${href}): no card id`);
      skippedNoId++;
      return;
    }
    const availabilityHref = box.find('link[itemprop="availability"]').first().attr('href');
    const available = availabilityHref === undefined ? null : readAvailability(availabilityHref);
    if (available === null) {
      skip(
        `"${title}" (${href}): ${availabilityHref === undefined ? 'no availability' : `unknown availability "${availabilityHref}"`}`
      );
      skippedInvalid++;
      return;
    }
    listings.push({
      shop: 'collect-it',
      url: new URL(href, BASE_URL).toString(),
      title,
      cardIds: [cardId],
      cardName: (match[2] ?? '').trim(),
      // The 600 px picture; the <img> shows the 200 px one.
      imageUrl:
        box.find('meta[itemprop="image"]').first().attr('content') ??
        box.find('.c-product-box-thumbnail img').first().attr('src') ??
        null,
      price: parsePrice(
        box.find('meta[itemprop="price"]').first().attr('content'),
        box.find('meta[itemprop="priceCurrency"]').first().attr('content')
      ),
      available,
      format: 'shop',
      auctionEndsAt: null,
      idConflict: false,
    });
  });

  return {
    listings,
    productCount: boxes.length,
    canonical: $('link[rel="canonical"]').first().attr('href') ?? null,
    next: $('link[rel="next"]').first().attr('href') ?? null,
    skippedNoId,
    skippedInvalid,
    firstSkipped,
  };
}

/**
 * Checks that a fetched page's canonical link names page `asked`; throws `ShopLayoutError`
 * when it is missing, unreadable, or names another page.
 */
function checkCanonical(canonical: string | null, asked: number): void {
  if (canonical === null)
    throw new ShopLayoutError(`collect-it: page ${asked} has no canonical link`);
  const page = categoryPageNumber(canonical);
  if (page === null) {
    throw new ShopLayoutError(
      `collect-it: page ${asked} has an unreadable canonical link "${canonical}"`
    );
  }
  if (page !== asked) {
    // The shop shrank during the run and redirected the request to another page.
    throw new ShopLayoutError(`collect-it: asked for page ${asked}, got page ${page}`);
  }
}

/** The URL of the next page that `page` links, or null on the last page. */
function nextPageUrl(next: string | null, page: number): string | null {
  if (next === null) return null;
  const nextPage = categoryPageNumber(next, BASE_URL);
  if (nextPage === null) {
    throw new ShopLayoutError(
      `collect-it: page ${page} has an unreadable next-page link "${next}"`
    );
  }
  if (nextPage !== page + 1) {
    throw new ShopLayoutError(`collect-it: page ${page} links page ${nextPage} as the next page`);
  }
  return new URL(next, BASE_URL).toString();
}

/**
 * collect-it.de lists every single card in one category, 30 per page. It hides sold-out products
 * instead of marking them, so a card that sells out simply vanishes (and the run marks the stored
 * listing unavailable). That makes a partial read dangerous: every card on an unread page would
 * read as sold out and re-notify on the next healthy run. So the walk follows each page's
 * `<link rel="next">`, and a page whose canonical link is missing, unreadable or names another
 * page than the one linked is a `ShopLayoutError` (a page past the end redirects to page 1), as is
 * reaching MAX_PAGES. The runner then leaves the stored listings untouched and retries next hour.
 */
export function createCollectItAdapter(
  fetchFn?: FetchFn,
  options: AdapterOptions = {}
): ShopAdapter {
  const sleep = options.sleep ?? realSleep;
  const delayMs = options.delayMs ?? PAGE_DELAY_MS;
  return {
    id: 'collect-it',
    async fetchListings(): Promise<FetchResult> {
      const byUrl = new Map<string, Listing>();
      let url: string | null = BASE_URL;
      for (let page = 1; url !== null; page++) {
        if (page > MAX_PAGES) {
          throw new ShopLayoutError(`collect-it: still a next page after ${MAX_PAGES} pages`);
        }
        if (page > 1) await sleep(delayMs);
        let parsed: ReturnType<typeof parseCollectItPage>;
        try {
          parsed = parseCollectItPage(await fetchText(url, fetchFn));
          if (parsed.productCount === 0) {
            // A bot wall, maintenance page or empty category; a linked page always has products.
            throw new ShopLayoutError(`collect-it: page ${page} has no products`);
          }
        } catch (error) {
          logError(`collect-it page ${page} failed`, error);
          throw error;
        }
        checkCanonical(parsed.canonical, page);
        const skipped = parsed.skippedNoId + parsed.skippedInvalid;
        if (skipped > 0) {
          // A sold-out card is hidden, so a box the parser cannot read would read as sold out.
          throw new ShopLayoutError(
            `collect-it: page ${page} has ${skipped} unreadable product box(es), first: ${parsed.firstSkipped}`
          );
        }
        for (const listing of parsed.listings) byUrl.set(listing.url, listing);
        url = nextPageUrl(parsed.next, page);
      }
      // Every page had products and none was skipped, so there is at least one listing.
      return { listings: [...byUrl.values()] };
    },
  };
}
