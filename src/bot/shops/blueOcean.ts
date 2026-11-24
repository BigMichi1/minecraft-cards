import * as cheerio from 'cheerio';
import { normalizeCardId, type CardId } from '../cards/cardId';
import { sleep as realSleep } from '../utils/async';
import { fetchText } from '../utils/http';
import logger, { logError } from '../utils/logger';
import type { AdapterOptions, FetchFn, FetchResult, Listing, ShopFetcher } from './types';
import { ShopLayoutError } from './types';

const ORIGIN = 'https://www.blue-ocean.de';
const BASE_URL = `${ORIGIN}/produkte/lego/lego-minecraft/lego-minecraft-sticker-cards/`;
const PAGE_DELAY_MS = 1500;
const MAX_PAGES = 60;
const CARD_TITLE_MARKER = 'LEGO Minecraft TCC';
// Quote characters around "On Fire" vary (straight, curly) and do not matter here.
const SERIES_3_MARKER = /on fire/i;
const LINK = 'a[data-testid="product-box-product-name-link"]';
// The page repeats unrelated products in a "recommended" slider below the grid.
const RECOMMENDATION_SLIDER = '.cms-element-product-slider, .product-slider-wrapper';

/**
 * True for a series 3 "On Fire" card title. The category also lists TCC series 1 and 2
 * cards, whose ids the URL suffix would turn into wrong series 3 ids.
 */
export function isOnFireCardTitle(title: string): boolean {
  return title.includes(CARD_TITLE_MARKER) && SERIES_3_MARKER.test(title);
}

function parsePrice(label: string | undefined): Listing['price'] {
  const match = /(\d+(?:\.\d+)?)/.exec(label ?? '');
  return match
    ? { cents: Math.round(Number.parseFloat(match[1] ?? '0') * 100), currency: 'EUR' }
    : null;
}

function idFromImage(src: string | undefined): CardId | null {
  if (!src) return null;
  const file = src.split('?')[0]?.split('/').pop() ?? '';
  const match = /P(\d+)\.[a-z]+$/i.exec(file);
  return match ? normalizeCardId(match[1] ?? '') : null;
}

/**
 * Parse one listing page. `productCount` counts every product box of the listing
 * grid, cards or not, so the caller can tell an exhausted pagination from a page of
 * non-card products. `skippedNoId` counts series 3 card boxes without a readable card id,
 * `skippedInvalid` boxes without a link.
 */
export function parseBlueOceanPage(html: string): {
  listings: Listing[];
  productCount: number;
  isCategoryPage: boolean;
  skippedNoId: number;
  skippedInvalid: number;
} {
  const $ = cheerio.load(html);
  const listings: Listing[] = [];
  let productCount = 0;
  let skippedNoId = 0;
  let skippedInvalid = 0;

  $(LINK).each((_, el) => {
    const link = $(el);
    if (link.closest(RECOMMENDATION_SLIDER).length > 0) return;
    productCount++;

    const title = link.text().replace(/\s+/g, ' ').trim();
    const href = link.attr('href');
    if (!href) {
      skippedInvalid++;
      return;
    }
    if (!isOnFireCardTitle(title)) return;

    const box = link.closest('[data-testid="product-box"], .product-card');
    const urlId = normalizeCardId(/-(\d+)$/.exec(href)?.[1] ?? '');
    const imageSrc = box.find('img[data-testid="product-box-img"]').first().attr('src');
    const imageId = idFromImage(imageSrc);
    const cardId = urlId ?? imageId;
    if (!cardId) {
      logger.warn(`blue-ocean: cannot read a card id for "${title}" (${href}), skipping`);
      skippedNoId++;
      return;
    }

    listings.push({
      shop: 'blue-ocean',
      url: new URL(href, ORIGIN).toString(),
      title,
      cardIds: [cardId],
      cardName: null,
      imageUrl: imageSrc ?? null,
      price: parsePrice(
        box
          .find('[data-testid="product-box-product-price"] [aria-label]')
          .first()
          .attr('aria-label')
      ),
      available: box.text().includes('Auf Lager'),
      format: 'shop',
      auctionEndsAt: null,
      idConflict: urlId !== null && imageId !== null && urlId !== imageId,
    });
  });
  // `.cms-page` wraps every real blue-ocean page, including an empty page past the end;
  // a bot wall or maintenance page lacks it.
  return {
    listings,
    productCount,
    isCategoryPage: $('.cms-page').length > 0,
    skippedNoId,
    skippedInvalid,
  };
}

export function createBlueOceanAdapter(
  fetchFn?: FetchFn,
  options: AdapterOptions = {}
): ShopFetcher {
  const sleep = options.sleep ?? realSleep;
  const delayMs = options.delayMs ?? PAGE_DELAY_MS;
  return {
    id: 'blue-ocean',
    async fetchListings(): Promise<FetchResult> {
      const byUrl = new Map<string, Listing>();
      let skippedNoId = 0;
      let skippedInvalid = 0;
      let exhausted = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (page > 1) await sleep(delayMs);
        let parsed: ReturnType<typeof parseBlueOceanPage>;
        try {
          parsed = parseBlueOceanPage(await fetchText(`${BASE_URL}?p=${page}`, fetchFn));
        } catch (error) {
          logError(`blue-ocean page ${page} failed`, error);
          throw error;
        }
        if (parsed.productCount === 0) {
          if (!parsed.isCategoryPage) {
            throw new ShopLayoutError(`blue-ocean: page ${page} is not a category page`);
          }
          exhausted = true;
          break;
        }
        for (const listing of parsed.listings) byUrl.set(listing.url, listing);
        skippedNoId += parsed.skippedNoId;
        skippedInvalid += parsed.skippedInvalid;
      }
      if (!exhausted) {
        logger.warn(`blue-ocean: stopped after ${MAX_PAGES} pages, later pages are not read`);
      }
      if (byUrl.size === 0) {
        throw new ShopLayoutError('blue-ocean: no card listings found on any page');
      }
      return { listings: [...byUrl.values()], skippedNoId, skippedInvalid };
    },
  };
}
