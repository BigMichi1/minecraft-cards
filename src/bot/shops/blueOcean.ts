import * as cheerio from 'cheerio';
import { normalizeCardId } from '../cards/cardId';
import { errorMessage, sleep as realSleep } from '../utils/async';
import { fetchText } from '../utils/http';
import logger from '../utils/logger';
import type { AdapterOptions, FetchFn, Listing, ShopAdapter } from './types';
import { ShopLayoutError } from './types';

const ORIGIN = 'https://www.blue-ocean.de';
const BASE_URL = `${ORIGIN}/produkte/lego/lego-minecraft/lego-minecraft-sticker-cards/`;
const PAGE_DELAY_MS = 1500;
const MAX_PAGES = 60;
const CARD_TITLE_MARKER = 'LEGO Minecraft TCC';
const LINK = 'a[data-testid="product-box-product-name-link"]';
// The page repeats unrelated products in a "recommended" slider below the grid.
const RECOMMENDATION_SLIDER = '.cms-element-product-slider, .product-slider-wrapper';

function parsePrice(label: string | undefined): Listing['price'] {
  const match = /(\d+(?:\.\d+)?)/.exec(label ?? '');
  return match
    ? { cents: Math.round(Number.parseFloat(match[1] ?? '0') * 100), currency: 'EUR' }
    : null;
}

function idFromImage(src: string | undefined): string | null {
  if (!src) return null;
  const file = src.split('?')[0]?.split('/').pop() ?? '';
  const match = /P(\d+)\.[a-z]+$/i.exec(file);
  return match ? normalizeCardId(match[1] ?? '') : null;
}

/**
 * Parse one listing page. `productCount` counts every product box of the listing
 * grid, cards or not, so the caller can tell an exhausted pagination from a page of
 * non-card products.
 */
export function parseBlueOceanPage(html: string): {
  listings: Listing[];
  productCount: number;
  isCategoryPage: boolean;
} {
  const $ = cheerio.load(html);
  const listings: Listing[] = [];
  let productCount = 0;

  $(LINK).each((_, el) => {
    const link = $(el);
    if (link.closest(RECOMMENDATION_SLIDER).length > 0) return;
    productCount++;

    const title = link.text().replace(/\s+/g, ' ').trim();
    const href = link.attr('href');
    if (!href || !title.includes(CARD_TITLE_MARKER)) return;

    const box = link.closest('[data-testid="product-box"], .product-card');
    const urlId = normalizeCardId(/-(\d+)$/.exec(href)?.[1] ?? '');
    const imageSrc = box.find('img[data-testid="product-box-img"]').first().attr('src');
    const imageId = idFromImage(imageSrc);
    const cardId = urlId ?? imageId;
    if (!cardId) {
      logger.warn(`blue-ocean: cannot read a card id for "${title}" (${href}), skipping`);
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
  return { listings, productCount, isCategoryPage: $('.cms-page').length > 0 };
}

export function createBlueOceanAdapter(
  fetchFn?: FetchFn,
  options: AdapterOptions = {}
): ShopAdapter {
  const sleep = options.sleep ?? realSleep;
  const delayMs = options.delayMs ?? PAGE_DELAY_MS;
  return {
    id: 'blue-ocean',
    async fetchListings() {
      const byUrl = new Map<string, Listing>();
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (page > 1) await sleep(delayMs);
        let parsed: ReturnType<typeof parseBlueOceanPage>;
        try {
          parsed = parseBlueOceanPage(await fetchText(`${BASE_URL}?p=${page}`, fetchFn));
        } catch (error) {
          logger.error(`blue-ocean page ${page} failed: ${errorMessage(error)}`);
          throw error;
        }
        if (parsed.productCount === 0) {
          if (!parsed.isCategoryPage) {
            throw new ShopLayoutError(`blue-ocean: page ${page} is not a category page`);
          }
          break;
        }
        for (const listing of parsed.listings) byUrl.set(listing.url, listing);
      }
      if (byUrl.size === 0) {
        throw new ShopLayoutError('blue-ocean: no card listings found on any page');
      }
      return [...byUrl.values()];
    },
  };
}
