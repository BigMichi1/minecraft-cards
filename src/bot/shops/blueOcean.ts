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

/** The pattern of a root URL ending in a collection's product code and a card number. */
function suffixPattern(collection: BlueOceanCollection): RegExp {
  // checkSettings (adapters.ts) allows only lowercase letters and digits in the code.
  return new RegExp(`-${collection.productCode}-(\\d+)$`);
}

/**
 * The collection a product URL belongs to: its category path (`…/trading-card-collection-serie-1/
 * 18166/nummer-250-i-…`, the card number from the slug's `nummer-NNN-`, null without one), else
 * the product code before the card number at the end of a root URL (`…-702351-09`, series 3's
 * `…-2dd00088-16`). Null for every other product: stickers, root URLs without a product code and
 * card number (packs, a changed URL form), other brands.
 */
function placeByUrl(
  href: string,
  collections: readonly BlueOceanCollection[],
  suffixes: ReadonlyMap<CollectionId, RegExp>
): Placement | null {
  const segments = new URL(href, ORIGIN).pathname.split('/').filter((x) => x.length > 0);
  const slug = (segments.at(-1) ?? '').toLowerCase();
  for (const collection of collections) {
    if (collection.categoryPath && segments.slice(0, -1).includes(collection.categoryPath)) {
      return { collection, urlNumber: normalizeCardId(/^nummer-(\d+)-/.exec(slug)?.[1] ?? '') };
    }
  }
  if (segments.length !== 1) return null;
  for (const collection of collections) {
    const suffix = suffixes.get(collection.id)?.exec(slug);
    if (suffix) return { collection, urlNumber: normalizeCardId(suffix[1] ?? '') };
  }
  return null;
}

/** True when the title or picture names `other` (its title marker, exclusion marker or picture part). */
function names(other: BlueOceanCollection, title: string, picture: string): boolean {
  return (
    (other.title?.test(title) ?? false) ||
    (other.excludes?.test(title) ?? false) ||
    (other.picture !== undefined && picture.includes(other.picture.toLowerCase()))
  );
}

/**
 * True when the title or picture contradicts the URL's collection: the title lacks the
 * collection's own marker, or names another collection (`names`: `On Fire` or `Boom-Bastic` at a
 * series 1 URL, or a `_tcc-02` picture).
 */
function contradicts(
  own: BlueOceanCollection,
  title: string,
  picture: string,
  known: readonly BlueOceanCollection[]
): boolean {
  if (own.title && !own.title.test(title)) return true;
  return known.some((other) => other.id !== own.id && names(other, title, picture));
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

/** One parsed listing page (`parseBlueOceanPage`). */
export interface BlueOceanPage {
  readonly listings: readonly Listing[];
  /** Every product box of the listing grid, cards or not. */
  readonly productCount: number;
  /** False for a bot wall or maintenance page (no `.cms-page`). */
  readonly isCategoryPage: boolean;
  readonly skippedNoId: number;
  readonly skippedExcluded: number;
  readonly skippedInvalid: number;
  /**
   * The collections of which this page holds a product that could not be read (excluded, without
   * a card id, or a single picture at an unknown URL): not a sell-out of theirs.
   */
  readonly unreadable: ReadonlySet<CollectionId>;
}

/**
 * Parse one listing page. `productCount` counts every product box of the listing grid, cards or
 * not, so the caller can tell an exhausted pagination from a page of non-card products. Each
 * product is placed in a collection by its URL (`placeByUrl`). Ignored (in `productCount` only,
 * in no skipped count): products no collection's URL names and whose picture names no
 * collection (stickers, packs, other brands), and products in a series 1 or 2 category without
 * a `Nummer` title nor a card number in the URL (packs there). `skippedExcluded` counts products
 * whose title or picture contradicts their URL's collection; `skippedNoId` series 1 and 2 singles
 * whose title number is missing or differs from the URL's number, and products at an unknown URL
 * whose picture names a collection (`_tcc-01`: a changed URL form); `skippedInvalid` boxes without
 * a link. `collections` are the ones read; the others of the registry still exclude by title and
 * picture.
 */
export function parseBlueOceanPage(
  html: string,
  collections: readonly BlueOceanCollection[] = BLUE_OCEAN_COLLECTIONS
): BlueOceanPage {
  const $ = cheerio.load(html);
  const known = [
    ...collections,
    ...BLUE_OCEAN_COLLECTIONS.filter((k) => !collections.some((c) => c.id === k.id)),
  ];
  const suffixes = new Map(collections.map((c) => [c.id, suffixPattern(c)]));
  const listings: Listing[] = [];
  const unreadable = new Set<CollectionId>();
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
    const box = link.closest('[data-testid="product-box"], .product-card');
    const imageSrc = box.find('img[data-testid="product-box-img"]').first().attr('src');
    const picture = pictureFile(imageSrc);
    const placement = placeByUrl(href, collections, suffixes);
    if (!placement) {
      // A single's picture (a series part and a card number, `250_…_tcc-01_de.jpg`) at a URL of
      // no known form: count it, so a changed URL form is seen. Pack pictures carry no number.
      const named = collections.filter(
        (c) =>
          c.picture !== undefined &&
          picture.includes(c.picture.toLowerCase()) &&
          (c.categoryPath !== undefined
            ? idFromNumberedPicture(picture)
            : idFromSeries3Picture(picture)) !== null
      );
      if (named.length > 0) {
        logger.warn(
          `blue-ocean: "${title}" (${href}) has a card picture but no known URL form, skipping`
        );
        for (const c of named) unreadable.add(c.id);
        skippedNoId++;
      }
      return;
    }
    const { collection, urlNumber } = placement;
    // A collection with a category path numbers its singles in the title (`Nummer NNN`).
    const numbered = collection.categoryPath !== undefined;
    const titleNumber = TITLE_NUMBER.exec(title);
    // A pack in the series' category: no `Nummer` title and no card number in its URL.
    if (numbered && !titleNumber && urlNumber === null) return;

    if (contradicts(collection, title, picture, known)) {
      unreadable.add(collection.id);
      skippedExcluded++;
      return;
    }

    const cardId = numbered ? normalizeCardId(titleNumber?.[1] ?? '') : urlNumber;
    if (!cardId || cardId !== urlNumber) {
      const why =
        urlNumber === null
          ? 'has no card number in its URL'
          : cardId
            ? 'has another number in its title than in its URL'
            : 'has no `Nummer` card number in its title';
      logger.warn(`blue-ocean: "${title}" ${why} (${href}), skipping`);
      unreadable.add(collection.id);
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
    unreadable,
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
      const unreadable = new Set<CollectionId>();
      let exhausted = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (page > 1) await sleep(delayMs);
        let parsed: BlueOceanPage;
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
        for (const c of parsed.unreadable) unreadable.add(c);
      }
      if (!exhausted) {
        logger.warn(`blue-ocean: stopped after ${MAX_PAGES} pages, later pages are not read`);
      }
      if (byUrl.size === 0) {
        throw new ShopLayoutError('blue-ocean: no card listings found on any page');
      }
      // A collection without a card in the whole walk: blue-ocean drops sold-out singles, so
      // it may have sold out, unless a product of it was seen but could not be read (a changed
      // title or URL form). The runner decides by its recent peak (EMPTY_COLLECTION_FLOOR).
      const listings = [...byUrl.values()];
      const emptyCollections = collections
        .filter((c) => !listings.some((l) => l.collection === c.id))
        .map((c) => c.id);
      const mayHaveSoldOut = emptyCollections.filter((c) => !unreadable.has(c));
      return {
        listings,
        skippedNoId,
        skippedExcluded,
        skippedInvalid,
        ...(emptyCollections.length > 0 ? { emptyCollections } : {}),
        ...(mayHaveSoldOut.length > 0 ? { mayHaveSoldOut } : {}),
      };
    },
  };
}
