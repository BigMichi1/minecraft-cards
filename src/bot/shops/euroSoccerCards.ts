import * as cheerio from 'cheerio';
import { normalizeCardIdIn, type CardId, type CardIdRule } from '../cards/cardId';
import type { EuroSoccerCardsSettings } from '../collections/ids';
import { errorMessage, sleep as realSleep } from '../utils/async';
import { fetchText, HttpError } from '../utils/http';
import logger from '../utils/logger';
import { clipText } from '../utils/messageLimit';
import { readAvailability } from './schemaOrg';
import type { AdapterOptions, FetchFn, FetchResult, Listing, ShopFetcher, ShopId } from './types';
import { ShopLayoutError } from './types';

const SHOP = 'euro-soccer-cards' satisfies ShopId;
const PAGE_DELAY_MS = 1500;
/** 11 pages on 2026-11-25. */
const MAX_PAGES = 40;
/** Products on every page but the last (from the saved pages). */
const PAGE_SIZE = 36;
const BOX = '.product-miniature';
const MAX_QUOTED = 200;
// "There are 392 products." above the grid (page 1 and every other page).
const PRODUCT_TOTAL = /^There (?:are|is) (\d+) products?\.$/;
// The picture's alt: "Buy Cards <name> Colección Turbo Attax 2026".
const ALT_NAME = /^Buy Cards (.+?)(?: Colección .*)?$/;

function quote(value: string): string {
  return `"${clipText(value, MAX_QUOTED)}"`;
}

/**
 * The page a URL names in `category`: exactly the category is page 1, the category with only
 * `?page=N` (N from 2) page N. Anything else (another host, language or path, more query
 * parameters, a fragment) is null: the walk cannot trust it.
 */
export function euroSoccerCardsPageNumber(href: string, category: string): number | null {
  const own = new URL(category);
  const url = URL.parse(href, category);
  if (!url || url.origin !== own.origin || url.pathname !== own.pathname || url.hash !== '') {
    return null;
  }
  if (url.search === '') return /[?#]/.test(href) ? null : 1;
  const page = /^\?page=([1-9]\d*)$/.exec(url.search)?.[1];
  const n = page === undefined ? Number.NaN : Number.parseInt(page, 10);
  return n >= 2 ? n : null;
}

/**
 * The card id in a product URL's last path segment: the slug, less `suffix` when it ends with it, ends with the card number, a prefix of the rule
 * and its number (`…-gu-1`), or a code family and its letters (`…-mr-ham`). Other words before
 * the number are names (`…-f1-car-184` is #184). Null when none of these.
 */
export function slugCardId(url: string, rule: CardIdRule, suffix: string): CardId | null {
  const parsed = URL.parse(url);
  if (!parsed) return null;
  let slug = parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1).toLowerCase();
  if (suffix && slug.endsWith(suffix)) slug = slug.slice(0, -suffix.length);
  const parts = slug.split('-');
  const last = parts.at(-1) ?? '';
  const before = parts.at(-2) ?? '';
  if (/^\d+$/.test(last)) {
    const prefixed = rule.prefixes.includes(before.toUpperCase())
      ? normalizeCardIdIn(rule, `${before}${last}`)
      : null;
    return prefixed ?? normalizeCardIdIn(rule, last);
  }
  if (/^[a-z]{3}$/.test(last) && (rule.codes ?? []).includes(before.toUpperCase())) {
    return normalizeCardIdIn(rule, `${before}-${last}`);
  }
  return null;
}

/** One parsed category page; see `parseEuroSoccerCardsPage`. */
export interface EuroSoccerCardsPage {
  readonly listings: Listing[];
  /** Every product box, read or not. */
  readonly productCount: number;
  /** The product total above the grid, null when absent or unreadable. */
  readonly total: number | null;
  /** The raw hrefs of `<link rel="canonical">` and `<link rel="next">`, null when absent. */
  readonly canonical: string | null;
  readonly next: string | null;
  /** Boxes without a link, a card id or a known availability. */
  readonly skipped: number;
  readonly firstSkipped: string | null;
}

/**
 * Parse one category page. The category holds only singles: a box whose id or availability
 * cannot be read is skipped and counted, and the fetcher fails the walk on any. A sold-out card
 * stays listed (`OutOfStock`), so it is stored unavailable, never skipped.
 */
export function parseEuroSoccerCardsPage(
  html: string,
  settings: EuroSoccerCardsSettings,
  rule: CardIdRule
): EuroSoccerCardsPage {
  const inCategory = (url: URL) =>
    url.origin === new URL(settings.category).origin &&
    url.pathname.startsWith(new URL(settings.category).pathname) &&
    !url.pathname.slice(new URL(settings.category).pathname.length).includes('/');
  const $ = cheerio.load(html);
  const listings: Listing[] = [];
  let skipped = 0;
  let firstSkipped: string | null = null;
  const skip = (what: string) => {
    skipped++;
    firstSkipped ??= what;
  };
  const boxes = $(BOX);
  boxes.each((index, el) => {
    const box = $(el);
    const href = box.find('.product-title a[href]').first().attr('href');
    const img = box.find('img').first();
    const linkText = box.find('.product-title a').first().text().replace(/\s+/g, ' ').trim();
    const alt = (img.attr('alt') ?? '').replace(/\s+/g, ' ').trim();
    const title = ALT_NAME.exec(alt)?.[1] ?? linkText;
    if (!href) {
      skip(`a product box without a link (${title ? quote(title) : `box ${index + 1}`})`);
      return;
    }
    const parsedUrl = URL.parse(href, settings.category);
    if (parsedUrl === null || !inCategory(parsedUrl)) {
      skip(`${quote(href)}: a link outside the category`);
      return;
    }
    const url = parsedUrl.toString();
    const cardId = slugCardId(url, rule, settings.slugSuffix);
    if (cardId === null) {
      skip(`${quote(href)}: no card id in the link`);
      return;
    }
    const availabilityHref = box.find('link[itemprop="availability"]').first().attr('href');
    const available = availabilityHref === undefined ? null : readAvailability(availabilityHref);
    if (available === null) {
      skip(
        `${quote(href)}: ${availabilityHref === undefined ? 'no availability' : `unknown availability ${quote(availabilityHref)}`}`
      );
      return;
    }
    const amount = box.find('[itemprop="price"]').first().attr('content');
    const currency = box.find('meta[itemprop="priceCurrency"]').first().attr('content') || 'EUR';
    let price: Listing['price'] = null;
    if (amount !== undefined && /^\d+(?:\.\d{1,2})?$/.test(amount)) {
      price = { cents: Math.round(Number.parseFloat(amount) * 100), currency };
    } else {
      logger.warn(
        `euro-soccer-cards: ${quote(href)} has ${amount === undefined ? 'no price' : `a malformed price ${quote(amount)}`}`
      );
    }
    const picture = img.attr('data-full-size-image-url') ?? img.attr('src');
    listings.push({
      shop: SHOP,
      url,
      title: title || href,
      cardIds: [cardId],
      cardName: title || null,
      imageUrl: picture ? (URL.parse(picture, url)?.toString() ?? null) : null,
      price,
      available,
      format: 'shop',
      auctionEndsAt: null,
      idConflict: false,
    });
  });
  const totalText = $('.total-products').first().text().replace(/\s+/g, ' ').trim();
  const total = PRODUCT_TOTAL.exec(totalText)?.[1];
  return {
    listings,
    productCount: boxes.length,
    total: total === undefined ? null : Number.parseInt(total, 10),
    canonical: $('link[rel="canonical"]').first().attr('href') ?? null,
    next: $('link[rel="next"]').first().attr('href') ?? null,
    skipped,
    firstSkipped,
  };
}

async function fetchPage(url: string, page: number, fetchFn: FetchFn | undefined): Promise<string> {
  try {
    return await fetchText(url, fetchFn);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new Error(`euro-soccer-cards: page ${page} failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

/**
 * euro-soccer-cards.com lists a set's singles in one category, 36 per page (`?page=N`), sold-out
 * cards included (`OutOfStock`). The walk follows `<link rel="next">`; each page's canonical link
 * must name the page asked for (a page past the end redirects to page 1), every page must hold
 * products and every box must be readable, every page linking a next one must be full, and the
 * cards read must equal the total page 1 names. Anything else, or reaching MAX_PAGES, is a
 * ShopLayoutError: a partial read would mark real listings gone. Card ids come from the URL slug
 * only (the list shows titles cut short, and the picture's alt names no number).
 */
export function createEuroSoccerCardsFetcher(
  settings: EuroSoccerCardsSettings,
  fetchFn: FetchFn | undefined,
  options: AdapterOptions,
  rule: CardIdRule
): ShopFetcher {
  const { category } = settings;
  const sleep = options.sleep ?? realSleep;
  const delayMs = options.delayMs ?? PAGE_DELAY_MS;
  return {
    id: SHOP,
    async fetchListings(): Promise<FetchResult> {
      const byUrl = new Map<string, Listing>();
      let url: string | null = category;
      let total: number | null = null;
      for (let page = 1; url !== null; page++) {
        if (page > MAX_PAGES) {
          throw new ShopLayoutError(
            `euro-soccer-cards: still a next page after ${MAX_PAGES} pages`
          );
        }
        if (page > 1) await sleep(delayMs);
        const parsed = parseEuroSoccerCardsPage(
          await fetchPage(url, page, fetchFn),
          settings,
          rule
        );
        if (parsed.productCount === 0) {
          throw new ShopLayoutError(`euro-soccer-cards: page ${page} has no products`);
        }
        const canonical =
          parsed.canonical === null ? null : euroSoccerCardsPageNumber(parsed.canonical, category);
        if (canonical === null) {
          throw new ShopLayoutError(
            `euro-soccer-cards: page ${page} has ${parsed.canonical === null ? 'no' : 'an unreadable'} canonical link`
          );
        }
        if (canonical !== page) {
          throw new ShopLayoutError(
            `euro-soccer-cards: asked for page ${page}, got page ${canonical}`
          );
        }
        if (parsed.skipped > 0) {
          throw new ShopLayoutError(
            `euro-soccer-cards: page ${page} has ${parsed.skipped} unreadable product box(es), first: ${parsed.firstSkipped}`
          );
        }
        if (page === 1) {
          if (parsed.total === null) {
            throw new ShopLayoutError('euro-soccer-cards: page 1 has no product total');
          }
          total = parsed.total;
        }
        for (const listing of parsed.listings) byUrl.set(listing.url, listing);
        if (parsed.next === null) {
          url = null;
        } else {
          const next = euroSoccerCardsPageNumber(parsed.next, category);
          if (next !== page + 1) {
            throw new ShopLayoutError(
              `euro-soccer-cards: page ${page} links ${next === null ? `an unreadable page ${quote(parsed.next)}` : `page ${next}`} as the next page`
            );
          }
          if (parsed.productCount !== PAGE_SIZE) {
            throw new ShopLayoutError(
              `euro-soccer-cards: page ${page} has ${parsed.productCount} products, but links a next page (a full page has ${PAGE_SIZE})`
            );
          }
          url = new URL(parsed.next, category).toString();
        }
      }
      if (byUrl.size !== total) {
        throw new ShopLayoutError(
          `euro-soccer-cards: read ${byUrl.size} products, but page 1 counts ${total}`
        );
      }
      return { listings: [...byUrl.values()] };
    },
  };
}
