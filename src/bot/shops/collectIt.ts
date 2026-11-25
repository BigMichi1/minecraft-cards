import * as cheerio from 'cheerio';
import { MINECRAFT_CARD_IDS, normalizeCardIdIn, type CardIdRule } from '../cards/cardId';
import { errorMessage, sleep as realSleep } from '../utils/async';
import { fetchText, HttpError } from '../utils/http';
import logger from '../utils/logger';
import { clipText } from '../utils/messageLimit';
import type { CategoryShopSettings } from '../collections/ids';
import type { AdapterOptions, FetchFn, FetchResult, Listing, ShopFetcher, ShopId } from './types';
import { sameSeries, ShopLayoutError } from './types';

const SHOP = 'collect-it' satisfies ShopId;
const ORIGIN = 'https://www.collect-it.de/';
const PAGE_DELAY_MS = 1500;
const MAX_PAGES = 60;
/** Products on every page but the last (from the saved pages). */
const PAGE_SIZE = 30;
const BOX = '#product-list .c-product-box';
/** Longest shop-controlled value quoted in a log or error message. */
const MAX_QUOTED = 200;

/** A shop-controlled value in double quotes, clipped so an error stays a readable admin DM. */
function quote(value: string): string {
  return `"${clipText(value, MAX_QUOTED)}"`;
}

// "Du hast 30 von 235 Artikeln gesehen" (a page with a next page) or
// "Du hast alle 235 Artikel gesehen" (the last page): 235 articles in the category.
const ARTICLE_TOTAL = /^Du hast (?:\d+ von|alle) (\d+) Artikeln? gesehen$/;

/** The category's article total from the pagination text, null when it cannot be read. */
export function readArticleTotal(text: string): number | null {
  const match = ARTICLE_TOTAL.exec(text);
  return match ? Number.parseInt(match[1] ?? '', 10) : null;
}

// "12 - Squid - Charakterkarte - Serie 3" -> id "12", name "Squid";
// "LE01 - Ender Dragon - Limitierte Karte - Serie 3" -> id "LE1" (canonical, the collection's rule).
// "XXL 1 - Explodierender Creeper - …" (series 1) -> id "XXL1";
// "MR-HAM - Lewis Hamilton - Manufactured Relic - 2026" (Turbo Attax) -> id "MR-HAM".
// The first part (letters and digits, at most one dash or space inside), spaces removed, is read
// with the collection's card id rule.
const TITLE_PATTERN = /^([A-Za-z0-9]+(?:[- ][A-Za-z0-9]+)?) - (.+?)(?: - |$)/;
// The last ` - ` part of a title naming a series, of the kind the collection's label is: "Serie 1"
// (LEGO Minecraft) or a year ("2026", Turbo Attax). A label of the other kind is no series label:
// collect-it changed its titles, so the box is unreadable rather than another series'.
const SERIE_SUFFIX = / - (Serie \d+)$/i;
const YEAR_SUFFIX = / - ((?:19|20)\d{2})$/;
const YEAR_LABEL = /^(?:19|20)\d{2}$/;

/** The series label a title ends with, of `series`' kind (either kind when null). */
function seriesLabel(title: string, series: string | null): string | undefined {
  const patterns =
    series === null
      ? [SERIE_SUFFIX, YEAR_SUFFIX]
      : [YEAR_LABEL.test(series) ? YEAR_SUFFIX : SERIE_SUFFIX];
  for (const pattern of patterns) {
    const label = pattern.exec(title)?.[1];
    if (label !== undefined) return label;
  }
  return undefined;
}
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

const PAGE_SUFFIX = /^_s([1-9]\d*)$/;

/**
 * The page number a URL names in `category`: exactly `category` is page 1, `category` plus
 * `_sN` page N. Anything else (another host or path, a trailing slash, a query or fragment, a
 * relative href when no base is given, `_s0`) is null: the walk cannot trust it.
 */
export function categoryPageNumber(href: string, category: string, base?: string): number | null {
  const own = new URL(category);
  const url = URL.parse(href, base);
  if (!url || url.origin !== own.origin || url.search !== '' || url.hash !== '') return null;
  // `URL` drops an empty `?` or `#`; the raw href must not carry one either.
  if (/[?#]/.test(href)) return null;
  if (url.pathname === own.pathname) return 1;
  if (!url.pathname.startsWith(own.pathname)) return null;
  const suffix = PAGE_SUFFIX.exec(url.pathname.slice(own.pathname.length));
  return suffix ? Number.parseInt(suffix[1] ?? '', 10) : null;
}

/**
 * The schema.org price (`0.55`, a dot and at most two decimals) in cents; currency EUR when
 * `priceCurrency` is missing. A missing or malformed price is null (shown as unknown) with a
 * warning naming `what` and the raw value.
 */
function parsePrice(
  amount: string | undefined,
  currency: string | undefined,
  what: string
): Listing['price'] {
  if (amount === undefined) {
    logger.warn(`collect-it: ${what} has no price`);
    return null;
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) {
    logger.warn(`collect-it: ${what} has a malformed price ${quote(amount)}`);
    return null;
  }
  return { cents: Math.round(Number.parseFloat(amount) * 100), currency: currency || 'EUR' };
}

/** `href` resolved against the shop, or null when it is missing or not a URL. */
function resolveUrl(href: string | undefined): string | null {
  return href ? (URL.parse(href, ORIGIN)?.toString() ?? null) : null;
}

/** One parsed category page; see `parseCollectItPage`. */
export interface CollectItPage {
  listings: Listing[];
  /** Every product box of the listing grid, read or not. */
  productCount: number;
  /** The raw href of `<link rel="canonical">`, null when absent. */
  canonical: string | null;
  /** The raw href of `<link rel="next">`, null when absent (the last page). */
  next: string | null;
  /** Boxes whose title does not start with a card number, or (with `series`) names no series. */
  skippedNoId: number;
  /** Card boxes whose title ends with another series label than `series`, by URL. */
  excluded: string[];
  /** Boxes without a link, a title or a known schema.org availability. */
  skippedInvalid: number;
  /** What the first skipped box lacked, naming its title or link; null when none was skipped. */
  firstSkipped: string | null;
  /** The pagination text (`.ci-pagination-meta`), whitespace collapsed; null when absent. */
  countText: string | null;
}

/**
 * Parse one category page. The category holds only singles, so a skipped box is parser drift,
 * and the adapter rejects a page with any. With `series`, a card box whose title ends with
 * another series label of the same kind (`Serie N`, or a year for a year label) goes to
 * `excluded` (no skip), and one with no label of that kind is a skip (the title format
 * changed); null reads either kind. Card ids are read with the collection's `rule` (Minecraft's
 * unless given). `canonical` and `next` are returned raw;
 * the adapter checks them with `categoryPageNumber`.
 */
export function parseCollectItPage(
  html: string,
  series: string | null,
  rule: CardIdRule = MINECRAFT_CARD_IDS
): CollectItPage {
  const $ = cheerio.load(html);
  const listings: Listing[] = [];
  const excluded: string[] = [];
  let skippedNoId = 0;
  let skippedInvalid = 0;
  let firstSkipped: string | null = null;
  const skip = (what: string): void => {
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
          ? `a product box without a title (${clipText(href, MAX_QUOTED)})`
          : `a product box without a link (${title ? quote(title) : `box ${index + 1}`})`
      );
      skippedInvalid++;
      return;
    }
    const url = resolveUrl(href);
    if (url === null) {
      skip(`${quote(title)}: unreadable link ${quote(href)}`);
      skippedInvalid++;
      return;
    }
    const titleSeries = seriesLabel(title, series);
    if (series !== null && titleSeries === undefined) {
      // A title naming no series of the collection's kind: the title format changed, so this
      // box cannot be trusted, and a box the walk drops would read as sold out (collect-it hides
      // sold-out cards).
      skip(`${quote(title)} (${clipText(url, MAX_QUOTED)}): no series label`);
      skippedNoId++;
      return;
    }
    if (series !== null && titleSeries !== undefined && !sameSeries(titleSeries, series)) {
      // Another series' card in this category, whatever its id: counted, never stored here.
      excluded.push(url);
      return;
    }
    const match = TITLE_PATTERN.exec(title);
    const cardId = match ? normalizeCardIdIn(rule, (match[1] ?? '').replace(/\s/g, '')) : null;
    if (!match || !cardId) {
      skip(`${quote(title)} (${clipText(url, MAX_QUOTED)}): no card id`);
      skippedNoId++;
      return;
    }
    const availabilityHref = box.find('link[itemprop="availability"]').first().attr('href');
    const available = availabilityHref === undefined ? null : readAvailability(availabilityHref);
    if (available === null) {
      skip(
        `${quote(title)} (${clipText(url, MAX_QUOTED)}): ${availabilityHref === undefined ? 'no availability' : `unknown availability ${quote(availabilityHref)}`}`
      );
      skippedInvalid++;
      return;
    }
    listings.push({
      shop: SHOP,
      url,
      title,
      cardIds: [cardId],
      cardName: (match[2] ?? '').trim(),
      // The microdata picture is the `md` size (600w in the <img> srcset); the <img> src, the
      // 200w `sm` size, is the fallback.
      imageUrl:
        resolveUrl(box.find('meta[itemprop="image"]').first().attr('content')) ??
        resolveUrl(box.find('.c-product-box-thumbnail img').first().attr('src')),
      price: parsePrice(
        box.find('meta[itemprop="price"]').first().attr('content'),
        box.find('meta[itemprop="priceCurrency"]').first().attr('content'),
        quote(title)
      ),
      available,
      format: 'shop',
      auctionEndsAt: null,
      idConflict: false,
    });
  });

  const skipped = skippedNoId + skippedInvalid;
  if (skipped > 0) {
    logger.warn(`collect-it: ${skipped} product box(es) skipped on a page, first: ${firstSkipped}`);
  }
  const countText = $('.ci-pagination-meta').first().text().replace(/\s+/g, ' ').trim();
  return {
    listings,
    productCount: boxes.length,
    canonical: $('link[rel="canonical"]').first().attr('href') ?? null,
    next: $('link[rel="next"]').first().attr('href') ?? null,
    skippedNoId,
    excluded,
    skippedInvalid,
    firstSkipped,
    countText: $('.ci-pagination-meta').length > 0 ? countText : null,
  };
}

/**
 * Checks that a fetched page's canonical link names page `asked`; throws `ShopLayoutError`
 * when it is missing, unreadable, or names another page.
 */
function checkCanonical(canonical: string | null, asked: number, category: string): void {
  if (canonical === null)
    throw new ShopLayoutError(`collect-it: page ${asked} has no canonical link`);
  const page = categoryPageNumber(canonical, category);
  if (page === null) {
    throw new ShopLayoutError(
      `collect-it: page ${asked} has an unreadable canonical link ${quote(canonical)}`
    );
  }
  if (page !== asked) {
    // The shop shrank during the run and redirected the request to another page.
    throw new ShopLayoutError(`collect-it: asked for page ${asked}, got page ${page}`);
  }
}

/**
 * The article total a page's pagination text names. Page 1 must have it; a later page may lack
 * it (undefined), but when it has one it must be readable. Throws `ShopLayoutError` otherwise.
 */
function pageTotal(countText: string | null, page: number): number | undefined {
  if (countText === null) {
    if (page === 1) throw new ShopLayoutError('collect-it: page 1 has no article count');
    return undefined;
  }
  const total = readArticleTotal(countText);
  if (total === null) {
    throw new ShopLayoutError(
      `collect-it: page ${page} has an unreadable article count ${quote(countText)}`
    );
  }
  return total;
}

/** The URL of the next page that `page` links, or null on the last page. */
function nextPageUrl(next: string | null, page: number, category: string): string | null {
  if (next === null) return null;
  const nextPage = categoryPageNumber(next, category, category);
  if (nextPage === null) {
    throw new ShopLayoutError(
      `collect-it: page ${page} has an unreadable next-page link ${quote(next)}`
    );
  }
  if (nextPage !== page + 1) {
    throw new ShopLayoutError(`collect-it: page ${page} links page ${nextPage} as the next page`);
  }
  return new URL(next, category).toString();
}

/**
 * Fetch one page. An HttpError already names the URL; any other failure (a timeout, a network
 * error) is rethrown naming the page, with the original as `cause`. Nothing is logged here: the
 * runner logs a failed shop once.
 */
async function fetchPage(url: string, page: number, fetchFn: FetchFn | undefined): Promise<string> {
  try {
    return await fetchText(url, fetchFn);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new Error(`collect-it: page ${page} failed: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * collect-it.de lists a series' single cards in one category (`settings.category`), 30 per page,
 * each title's card id read with the collection's `rule`. It hides sold-out products instead of
 * marking them, so a card that sells out simply vanishes (and the run marks the stored
 * listing unavailable). That makes a partial read dangerous: every card on an unread page would
 * read as sold out and re-notify on the next healthy run. So the walk follows each page's
 * `<link rel="next">`, and a page whose canonical link is missing, unreadable or names another
 * page than the one linked is a `ShopLayoutError` (a page past the end redirects to page 1), as is
 * reaching MAX_PAGES or any unreadable product box or title. So is a walk whose unique listings
 * and other-series items (`skippedExcluded`) do not add up to the article total page 1 names, or
 * that finds no card of the category's series, or a page with a next page that is not full
 * (PAGE_SIZE): both catch a dropped `rel="next"` and cards shifting between pages. The runner
 * then leaves the stored listings untouched, and the run is retried next hour.
 */
export function createCollectItFetcher(
  settings: CategoryShopSettings,
  fetchFn?: FetchFn,
  options: AdapterOptions = {},
  rule: CardIdRule = MINECRAFT_CARD_IDS
): ShopFetcher {
  const { category, series } = settings;
  const sleep = options.sleep ?? realSleep;
  const delayMs = options.delayMs ?? PAGE_DELAY_MS;
  return {
    id: SHOP,
    async fetchListings(): Promise<FetchResult> {
      const byUrl = new Map<string, Listing>();
      // Another series' cards in the category: not stored, but counted in the article total.
      const excluded = new Set<string>();
      let url: string | null = category;
      let total: number | undefined;
      for (let page = 1; url !== null; page++) {
        if (page > MAX_PAGES) {
          throw new ShopLayoutError(`collect-it: still a next page after ${MAX_PAGES} pages`);
        }
        if (page > 1) await sleep(delayMs);
        const parsed = parseCollectItPage(await fetchPage(url, page, fetchFn), series, rule);
        if (parsed.productCount === 0) {
          // A bot wall, maintenance page or empty category; a linked page always has products.
          throw new ShopLayoutError(`collect-it: page ${page} has no products`);
        }
        checkCanonical(parsed.canonical, page, category);
        const skipped = parsed.skippedNoId + parsed.skippedInvalid;
        if (skipped > 0) {
          // A sold-out card is hidden, so a box the parser cannot read would read as sold out.
          throw new ShopLayoutError(
            `collect-it: page ${page} has ${skipped} unreadable product box(es), first: ${parsed.firstSkipped}`
          );
        }
        const pageCount = pageTotal(parsed.countText, page);
        if (total === undefined) {
          total = pageCount;
        } else if (pageCount !== undefined && pageCount !== total) {
          throw new ShopLayoutError(
            `collect-it: page ${page} counts ${pageCount} articles, page 1 counted ${total}`
          );
        }
        for (const listing of parsed.listings) byUrl.set(listing.url, listing);
        for (const other of parsed.excluded) excluded.add(other);
        url = nextPageUrl(parsed.next, page, category);
        if (url !== null && parsed.productCount !== PAGE_SIZE) {
          // Only the last page may be short; a short middle page means the pages shifted.
          throw new ShopLayoutError(
            `collect-it: page ${page} has ${parsed.productCount} products, but links a next page (a full page has ${PAGE_SIZE})`
          );
        }
      }
      // Catches a dropped rel="next" (page 1 read alone) and cards that moved between pages
      // during the walk (one sold out, so a later card moved onto a page already read).
      // A URL read as this series' card on one page is never also counted as another series'.
      for (const url of byUrl.keys()) excluded.delete(url);
      if (byUrl.size === 0) {
        // Every card of another series (a series label typo, or a renamed suffix): reading it as
        // none would mark every stored listing sold out.
        throw new ShopLayoutError(`collect-it: no card listings of ${series} found`);
      }
      if (byUrl.size + excluded.size !== total) {
        throw new ShopLayoutError(
          `collect-it: read ${byUrl.size + excluded.size} listings, but page 1 counts ${total} articles`
        );
      }
      return {
        listings: [...byUrl.values()],
        ...(excluded.size > 0 ? { skippedExcluded: excluded.size } : {}),
      };
    },
  };
}
