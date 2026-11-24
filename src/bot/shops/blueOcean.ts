import * as cheerio from 'cheerio';
import { normalizeCardId, type CardId } from '../cards/cardId';
import type { BlueOceanSettings, CollectionDefinition, CollectionId } from '../collections/ids';
import { COLLECTIONS } from '../collections/index';
import { sleep as realSleep } from '../utils/async';
import { fetchText } from '../utils/http';
import logger, { logError } from '../utils/logger';
import type { AdapterOptions, FetchFn, FetchResult, Listing, ShopFetcher } from './types';
import { ShopLayoutError } from './types';

const ORIGIN = 'https://www.blue-ocean.de';
const BASE_URL = `${ORIGIN}/produkte/lego/lego-minecraft/lego-minecraft-sticker-cards/`;
const PAGE_DELAY_MS = 1500;
const MAX_PAGES = 60;
const LINK = 'a[data-testid="product-box-product-name-link"]';
// The page repeats unrelated products in a "recommended" slider below the grid.
const RECOMMENDATION_SLIDER = '.cms-element-product-slider, .product-slider-wrapper';
/** A series 1 or 2 single's title starts with its number: `Nummer 250 I Schildkröte`. */
const TITLE_NUMBER = /^Nummer\s+(\d+)\b/i;

/** A collection's blue-ocean settings, with its id. */
export type BlueOceanCollection = BlueOceanSettings & { readonly id: CollectionId };

/** The collections whose definition names blue-ocean settings, in registry order. */
export function blueOceanCollectionsOf(
  definitions: readonly CollectionDefinition[]
): BlueOceanCollection[] {
  return definitions.flatMap((d) => {
    const settings = d.shops['blue-ocean'];
    return settings ? [{ id: d.id, ...settings }] : [];
  });
}

export const BLUE_OCEAN_COLLECTIONS: readonly BlueOceanCollection[] =
  blueOceanCollectionsOf(COLLECTIONS);

/** Where a product URL places it: the collection, and the card number the URL names. */
interface Placement {
  readonly collection: BlueOceanCollection;
  readonly urlNumber: CardId | null;
}

/**
 * The collection a product URL belongs to: its category path (`…/trading-card-collection-serie-1/
 * 18166/nummer-250-i-…`), else the product code before the card number at the end of a root URL
 * (`…-702351-09`, series 3's `…-2dd00088-16`). Null for every other product (stickers, packs,
 * other brands).
 */
function placeByUrl(href: string, collections: readonly BlueOceanCollection[]): Placement | null {
  const segments = new URL(href, ORIGIN).pathname.split('/').filter((x) => x.length > 0);
  const slug = segments.at(-1) ?? '';
  for (const collection of collections) {
    if (collection.categoryPath && segments.slice(0, -1).includes(collection.categoryPath)) {
      return { collection, urlNumber: normalizeCardId(/^nummer-(\d+)-/.exec(slug)?.[1] ?? '') };
    }
  }
  if (segments.length !== 1) return null;
  for (const collection of collections) {
    const suffix = new RegExp(`-${collection.productCode}-(\\d+)$`).exec(slug);
    if (suffix) return { collection, urlNumber: normalizeCardId(suffix[1] ?? '') };
  }
  return null;
}

/**
 * True when the title or picture contradicts the URL's collection: the title lacks the
 * collection's own marker, or names another collection's, or the picture file names another
 * collection's series (`_tcc-02` at a series 1 URL).
 */
function contradicts(
  own: BlueOceanCollection,
  title: string,
  picture: string,
  known: readonly BlueOceanCollection[]
): boolean {
  if (own.title && !own.title.test(title)) return true;
  return known.some(
    (other) =>
      other.id !== own.id &&
      ((other.title?.test(title) ?? false) ||
        (other.picture !== undefined && picture.includes(other.picture.toLowerCase())))
  );
}

function parsePrice(label: string | undefined): Listing['price'] {
  const match = /(\d+(?:\.\d+)?)/.exec(label ?? '');
  return match
    ? { cents: Math.round(Number.parseFloat(match[1] ?? '0') * 100), currency: 'EUR' }
    : null;
}

/** The picture's file name, lowercased, without query. */
function pictureFile(src: string | undefined): string {
  return (src ?? '').split('?')[0]?.split('/').pop()?.toLowerCase() ?? '';
}

/** Series 3's picture names its card: `LMC_TCG3_.P114.jpg`. */
function idFromSeries3Picture(file: string): CardId | null {
  const match = /p(\d+)\.[a-z]+$/.exec(file);
  return match ? normalizeCardId(match[1] ?? '') : null;
}

/** Series 1 and 2 pictures start with their card number: `250_lego_minecraft_tcc-01_de.jpg`. */
function idFromNumberedPicture(file: string): CardId | null {
  const match = /^(\d+)_/.exec(file);
  return match ? normalizeCardId(match[1] ?? '') : null;
}

/**
 * Parse one listing page. `productCount` counts every product box of the listing
 * grid, cards or not, so the caller can tell an exhausted pagination from a page of
 * non-card products. Each product is placed in a collection by its URL (`placeByUrl`); one
 * no collection's URL names (stickers, packs) is not counted, nor is a series 1 or 2 product
 * without a `Nummer` title (a pack in the series' category). `skippedExcluded` counts products
 * whose title or picture contradicts their URL's collection, `skippedNoId` series 1 and 2 singles
 * whose title number differs from the URL's, `skippedInvalid` boxes without a link.
 * `collections` are the ones read; the others of the registry still exclude by title and picture.
 */
export function parseBlueOceanPage(
  html: string,
  collections: readonly BlueOceanCollection[] = BLUE_OCEAN_COLLECTIONS
): {
  listings: Listing[];
  productCount: number;
  isCategoryPage: boolean;
  skippedNoId: number;
  skippedExcluded: number;
  skippedInvalid: number;
} {
  const $ = cheerio.load(html);
  const known = [
    ...collections,
    ...BLUE_OCEAN_COLLECTIONS.filter((k) => !collections.some((c) => c.id === k.id)),
  ];
  const listings: Listing[] = [];
  let productCount = 0;
  let skippedNoId = 0;
  let skippedExcluded = 0;
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
    const placement = placeByUrl(href, collections);
    if (!placement) return;
    const { collection, urlNumber } = placement;
    const numbered = collection.categoryPath !== undefined;
    const titleNumber = TITLE_NUMBER.exec(title);
    if (numbered && !titleNumber) return;

    const box = link.closest('[data-testid="product-box"], .product-card');
    const imageSrc = box.find('img[data-testid="product-box-img"]').first().attr('src');
    const picture = pictureFile(imageSrc);
    if (contradicts(collection, title, picture, known)) {
      skippedExcluded++;
      return;
    }

    const cardId = numbered ? normalizeCardId(titleNumber?.[1] ?? '') : urlNumber;
    if (!cardId || cardId !== urlNumber) {
      logger.warn(
        `blue-ocean: the title number of "${title}" is not its URL's (${href}), skipping`
      );
      skippedNoId++;
      return;
    }
    const pictureId = numbered ? idFromNumberedPicture(picture) : idFromSeries3Picture(picture);

    listings.push({
      shop: 'blue-ocean',
      collection: collection.id,
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
      idConflict: pictureId !== null && pictureId !== cardId,
    });
  });
  // `.cms-page` wraps every real blue-ocean page, including an empty page past the end;
  // a bot wall or maintenance page lacks it.
  return {
    listings,
    productCount,
    isCategoryPage: $('.cms-page').length > 0,
    skippedNoId,
    skippedExcluded,
    skippedInvalid,
  };
}

export function createBlueOceanFetcher(
  fetchFn?: FetchFn,
  options: AdapterOptions = {},
  collections: readonly BlueOceanCollection[] = BLUE_OCEAN_COLLECTIONS
): ShopFetcher {
  const sleep = options.sleep ?? realSleep;
  const delayMs = options.delayMs ?? PAGE_DELAY_MS;
  return {
    id: 'blue-ocean',
    async fetchListings(): Promise<FetchResult> {
      const byUrl = new Map<string, Listing>();
      let skippedNoId = 0;
      let skippedExcluded = 0;
      let skippedInvalid = 0;
      let exhausted = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (page > 1) await sleep(delayMs);
        let parsed: ReturnType<typeof parseBlueOceanPage>;
        try {
          parsed = parseBlueOceanPage(
            await fetchText(`${BASE_URL}?p=${page}`, fetchFn),
            collections
          );
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
        skippedExcluded += parsed.skippedExcluded;
        skippedInvalid += parsed.skippedInvalid;
      }
      if (!exhausted) {
        logger.warn(`blue-ocean: stopped after ${MAX_PAGES} pages, later pages are not read`);
      }
      if (byUrl.size === 0) {
        throw new ShopLayoutError('blue-ocean: no card listings found on any page');
      }
      return { listings: [...byUrl.values()], skippedNoId, skippedExcluded, skippedInvalid };
    },
  };
}
