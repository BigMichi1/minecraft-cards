import * as cheerio from 'cheerio';
import { normalizeCardId } from '../cards/cardId';
import { sleep as realSleep } from '../utils/async';
import { fetchText } from '../utils/http';
import logger, { logError } from '../utils/logger';
import type { AdapterOptions, FetchFn, FetchResult, Listing, ShopFetcher } from './types';
import { ShopLayoutError } from './types';

const BASE_URL = 'https://shop-sammel-ente.de/Minecraft/Serie-3/';
const PAGE_DELAY_MS = 1500;
const MAX_PAGES = 60;

// "LEGO Minecraft Serie 3 | #012 Squid" -> id "12" (canonical, normalizeCardId), name "Squid". Puzzle packs
// ("... Puzzle-Paket #1 (154 - 162)") have no pipe, boosters and starter packs no "#".
const TITLE_PATTERN = /\|\s*#((?:LE|XXL)?\d+)\s+(\S.*)$/i;

function parsePrice(text: string): Listing['price'] {
  const match = /(\d+(?:\.\d{3})*),(\d{2})\s*€/.exec(text.replace(/\s+/g, ' '));
  if (!match) return null;
  const euros = Number.parseInt((match[1] ?? '').replace(/\./g, ''), 10);
  return { cents: euros * 100 + Number.parseInt(match[2] ?? '0', 10), currency: 'EUR' };
}

/**
 * Parse one category page. `productCount` counts every product box, cards or not; of the boxes
 * that are not card listings, `skippedNoId` had a title naming a card number ("|#" or "| #")
 * that could not be read (other products such as boosters and puzzle packs are not counted) and
 * `skippedInvalid` no link or title. `lastPage` is the highest `?p=N` in the pagination (1 when
 * none).
 */
export function parseSammelEntePage(html: string): {
  listings: Listing[];
  lastPage: number;
  productCount: number;
  skippedNoId: number;
  skippedInvalid: number;
} {
  const $ = cheerio.load(html);

  let lastPage = 1;
  $('a[href*="?p="]').each((_, el) => {
    const page = Number.parseInt(/[?&]p=(\d+)/.exec($(el).attr('href') ?? '')?.[1] ?? '', 10);
    if (page > lastPage) lastPage = page;
  });

  const listings: Listing[] = [];
  let skippedNoId = 0;
  let skippedInvalid = 0;
  const boxes = $('.card.product-box');
  boxes.each((_, el) => {
    const box = $(el);
    const link = box.find('a.product-name').first();
    const href = link.attr('href');
    const title = link.text().replace(/\s+/g, ' ').trim();
    if (!href || !title) {
      skippedInvalid++;
      return;
    }
    const match = TITLE_PATTERN.exec(title);
    const cardId = match ? normalizeCardId(match[1] ?? '') : null;
    if (!match || !cardId) {
      // Boosters, starter packs and puzzle packs are no cards; only a title that names a card
      // number ("| #", with or without a space) we could not read counts, so a parser drift
      // shows in the summary.
      if (/\|\s*#/.test(title)) skippedNoId++;
      return;
    }

    listings.push({
      shop: 'sammel-ente',
      url: new URL(href, BASE_URL).toString(),
      title,
      cardIds: [cardId],
      cardName: (match[2] ?? '').trim(),
      imageUrl: box.find('img.product-image').first().attr('src') ?? null,
      price: parsePrice(box.find('.product-price').first().text()),
      available: box.find('.delivery-information.delivery-available').length > 0,
      format: 'shop',
      auctionEndsAt: null,
      idConflict: false,
    });
  });
  return { listings, lastPage, productCount: boxes.length, skippedNoId, skippedInvalid };
}

export function createSammelEnteAdapter(
  fetchFn?: FetchFn,
  options: AdapterOptions = {}
): ShopFetcher {
  const sleep = options.sleep ?? realSleep;
  const delayMs = options.delayMs ?? PAGE_DELAY_MS;
  return {
    id: 'sammel-ente',
    async fetchListings(): Promise<FetchResult> {
      const first = parseSammelEntePage(await fetchText(`${BASE_URL}?p=1`, fetchFn));
      const byUrl = new Map(first.listings.map((l) => [l.url, l]));
      let { skippedNoId, skippedInvalid } = first;
      if (first.lastPage > MAX_PAGES) {
        logger.warn(`sammel-ente: ${first.lastPage} pages, reading only the first ${MAX_PAGES}`);
      }
      const lastPage = Math.min(first.lastPage, MAX_PAGES);
      for (let page = 2; page <= lastPage; page++) {
        await sleep(delayMs);
        try {
          const parsed = parseSammelEntePage(await fetchText(`${BASE_URL}?p=${page}`, fetchFn));
          if (parsed.productCount === 0) {
            // A real category page always has product boxes up to lastPage.
            throw new ShopLayoutError(`sammel-ente: page ${page} of ${lastPage} has no products`);
          }
          for (const listing of parsed.listings) byUrl.set(listing.url, listing);
          skippedNoId += parsed.skippedNoId;
          skippedInvalid += parsed.skippedInvalid;
        } catch (error) {
          logError(`sammel-ente page ${page} failed`, error);
          throw error;
        }
      }
      if (byUrl.size === 0) {
        throw new ShopLayoutError('sammel-ente: no card listings found on any page');
      }
      return { listings: [...byUrl.values()], skippedNoId, skippedInvalid };
    },
  };
}
