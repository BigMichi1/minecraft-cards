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
/** The page cap; the category had 11 pages on 2026-11-25. */
const MAX_PAGES = 40;
/** Products on every page but the last (from the saved pages). */
const PAGE_SIZE = 36;
const BOX = '.product-miniature';
const MAX_QUOTED = 200;
// "There are 392 products." above the grid (page 1 and every other page).
const PRODUCT_TOTAL = /^There (?:are|is) (\d+) products?\.$/;
// The picture's alt: "Buy Cards <name> Colección Turbo Attax 2026", also "Buy Cards online <name>
// …" and "Buy Cards <name> Topps Formula 1 Turbo Attax 2026".
const ALT_NAME = /^Buy Cards (?:online )?(.+?)(?: (?:Colección|Topps Formula) .*)?$/;
// The id a link text ends with when it is not cut ("… Hero 4", "… SUN 8", "… Relic MR-HAM").
const TEXT_ID = /(?:^|\s)((?:[A-Za-z]{2,3}[\s-]?)?[A-Za-z0-9]{1,3})$/;
/** A price in the microdata's `content`: digits, a dot and at most two decimals. */
const PRICE = /^\d+(?:\.\d{1,2})?$/;

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
 * The card id at the end of a product URL's last path segment, after `suffix` is cut off: a
 * bare number (`…-184`), a rule prefix and its number (`…-gu-1` is GU1; a prefixed number the
 * rule refuses falls back to the bare number), or a code family and its three letters
 * (`…-mr-ham`). Any other word before the number is part of the name (`…-f1-car-184` is #184).
 * Null otherwise, also for a tail of four or more digits (a year: a changed suffix).
 */
export function slugCardId(url: string, rule: CardIdRule, suffix: string): CardId | null {
  const parsed = URL.parse(url);
  if (!parsed) return null;
  let slug = parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1).toLowerCase();
  if (suffix && slug.endsWith(suffix)) slug = slug.slice(0, -suffix.length);
  const parts = slug.split('-');
  const last = parts.at(-1) ?? '';
  const before = parts.at(-2) ?? '';
  // A four-digit tail is a year or a changed slug suffix ("…-2026"), never a card number here.
  if (/^\d{4,}$/.test(last)) return null;
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
  /**
   * Boxes without a link, with a link outside the category, without a card id (or with a link
   * text naming another card), a known and consistent availability, or a readable price.
   */
  readonly skipped: number;
  readonly firstSkipped: string | null;
}

/**
 * Parse one category page. The category holds only singles: a box whose link, id, availability
 * or price cannot be read is skipped and counted (also one whose uncut link text ends with
 * another card's id than its slug), and the fetcher fails the walk on any. A sold-out card
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
    // Stored without query or fragment (PrestaShop adds `#/…` for combinations), so a listing
    // keeps one URL from run to run.
    const url = `${parsedUrl.origin}${parsedUrl.pathname}`;
    const cardId = slugCardId(url, rule, settings.slugSuffix);
    if (cardId === null) {
      skip(`${quote(href)}: no card id in the link`);
      return;
    }
    // A link text that is not cut ends with the card's id: it must name the slug's card.
    const textId = linkText.endsWith('...')
      ? null
      : normalizeCardIdIn(rule, (TEXT_ID.exec(linkText)?.[1] ?? '').replace(/\s/g, ''));
    if (textId !== null && textId !== cardId) {
      skip(`${quote(href)}: its text ${quote(linkText)} names another card than its link`);
      return;
    }
    // Every availability link of the box must say the same.
    const states = box
      .find('link[itemprop="availability"]')
      .map((_, link) => readAvailability($(link).attr('href') ?? ''))
      .get() as (boolean | null)[];
    const available = states.length > 0 && states.every((v) => v === states[0]) ? states[0] : null;
    if (available === null || available === undefined) {
      skip(
        `${quote(href)}: ${states.length === 0 ? 'no availability' : 'an unknown or conflicting availability'}`
      );
      return;
    }
    const amount = box.find('[itemprop="price"]').first().attr('content');
    if (amount === undefined || !PRICE.test(amount)) {
      skip(
        `${quote(href)}: ${amount === undefined ? 'no price' : `a malformed price ${quote(amount)}`}`
      );
      return;
    }
    const currency = box.find('meta[itemprop="priceCurrency"]').first().attr('content') || 'EUR';
    const price = { cents: Math.round(Number.parseFloat(amount) * 100), currency };
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
 * products and every box must be readable, every page's `rel="next"` must name the next page,
 * every page linking a next one must be full, and the distinct products read must equal the
 * total page 1 names. Anything else, or reaching MAX_PAGES, is a
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
      // One card under two URLs is the sign of a misread slug: logged for the admin's log.
      const urlsById = new Map<CardId, string[]>();
      for (const l of byUrl.values()) {
        for (const id of l.cardIds) urlsById.set(id, [...(urlsById.get(id) ?? []), l.url]);
      }
      for (const [id, urls] of urlsById) {
        if (urls.length > 1) {
          logger.warn(
            `euro-soccer-cards: card ${id} under ${urls.length} products: ${urls.join(', ')}`
          );
        }
      }
      return { listings: [...byUrl.values()] };
    },
  };
}
