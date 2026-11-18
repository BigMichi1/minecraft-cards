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
// schema.org availability values that mean "can be ordered now".
const AVAILABLE = new Set(['https://schema.org/InStock', 'https://schema.org/LimitedAvailability']);

/** Page N lives at `…/Einzelkarten_sN`; page 1 has no suffix. */
function pageUrl(page: number): string {
  return page === 1 ? BASE_URL : `${BASE_URL}_s${page}`;
}

function parsePrice(amount: string | undefined, currency: string | undefined): Listing['price'] {
  if (!amount || !/^\d+(?:\.\d{1,2})?$/.test(amount)) return null;
  return { cents: Math.round(Number.parseFloat(amount) * 100), currency: currency || 'EUR' };
}

/**
 * Parse one category page. `productCount` counts every product box of the listing grid;
 * `skippedNoId` counts boxes whose title does not start with a card number (the category holds
 * only singles, so any such title is parser drift), `skippedInvalid` boxes without a link or
 * title. `page` is the page number the canonical link names (null when there is none), and
 * `hasNext` whether the page links a next page.
 */
export function parseCollectItPage(html: string): {
  listings: Listing[];
  productCount: number;
  page: number | null;
  hasNext: boolean;
  skippedNoId: number;
  skippedInvalid: number;
} {
  const $ = cheerio.load(html);
  const listings: Listing[] = [];
  let skippedNoId = 0;
  let skippedInvalid = 0;

  const boxes = $(BOX);
  boxes.each((_, el) => {
    const box = $(el);
    const title = box
      .find('.c-product-box-content-title')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    const href = box.find('.c-product-box-content a[href]').first().attr('href');
    if (!href || !title) {
      skippedInvalid++;
      return;
    }
    const match = TITLE_PATTERN.exec(title);
    const cardId = match ? normalizeCardId(match[1] ?? '') : null;
    if (!match || !cardId) {
      logger.warn(`collect-it: cannot read a card id for "${title}" (${href}), skipping`);
      skippedNoId++;
      return;
    }
    const availability = box.find('link[itemprop="availability"]').first().attr('href') ?? '';
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
      available: AVAILABLE.has(availability),
      format: 'shop',
      auctionEndsAt: null,
      idConflict: false,
    });
  });

  const canonical = $('link[rel="canonical"]').first().attr('href');
  const page =
    canonical === undefined ? null : Number.parseInt(/_s(\d+)$/.exec(canonical)?.[1] ?? '1', 10);
  return {
    listings,
    productCount: boxes.length,
    page,
    hasNext: $('link[rel="next"]').length > 0,
    skippedNoId,
    skippedInvalid,
  };
}

/**
 * collect-it.de lists every single card in one category, 30 per page. It hides sold-out products
 * instead of marking them, so a card that sells out simply vanishes (and the run marks the stored
 * listing unavailable). A page past the end redirects to page 1, so the pages are walked by the
 * `<link rel="next">` of each page, never by guessing a page count.
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
      let skippedNoId = 0;
      let skippedInvalid = 0;
      for (let page = 1; ; page++) {
        if (page > 1) await sleep(delayMs);
        let parsed: ReturnType<typeof parseCollectItPage>;
        try {
          parsed = parseCollectItPage(await fetchText(pageUrl(page), fetchFn));
          if (parsed.productCount === 0) {
            // A bot wall, maintenance page or empty category; a linked page always has products.
            throw new ShopLayoutError(`collect-it: page ${page} has no products`);
          }
        } catch (error) {
          logError(`collect-it page ${page} failed`, error);
          throw error;
        }
        if (parsed.page !== page) {
          // The shop shrank since the previous page and redirected to another page.
          logger.warn(`collect-it: asked for page ${page}, got page ${parsed.page}; stopping`);
          break;
        }
        for (const listing of parsed.listings) byUrl.set(listing.url, listing);
        skippedNoId += parsed.skippedNoId;
        skippedInvalid += parsed.skippedInvalid;
        if (!parsed.hasNext) break;
        if (page === MAX_PAGES) {
          logger.warn(`collect-it: stopped after ${MAX_PAGES} pages, later pages are not read`);
          break;
        }
      }
      if (byUrl.size === 0) {
        throw new ShopLayoutError('collect-it: no card listings found on any page');
      }
      return { listings: [...byUrl.values()], skippedNoId, skippedInvalid };
    },
  };
}
