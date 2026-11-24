import type { CardId } from '../cards/cardId';
import type { CollectionId } from '../collections/ids';
import { legoMinecraft3 } from '../collections/legoMinecraft3';
import type { Config } from '../config';
import logger from '../utils/logger';
import { createBlueOceanFetcher } from './blueOcean';
import { createCollectItFetcher } from './collectIt';
import { createEbayFetcher } from './ebay';
import { createSammelEnteFetcher } from './sammelEnte';
import { SHOP_IDS, type ShopAdapter, type ShopFetcher, type ShopId } from './types';

/**
 * One factory per shop that needs no credentials. A `ShopId` without an entry here is a
 * compile error, so a new shop cannot be left out of the checks by accident.
 */
const SHOP_FACTORIES: Record<Exclude<ShopId, 'ebay'>, () => ShopFetcher> = {
  'sammel-ente': () => createSammelEnteFetcher(),
  'blue-ocean': () => createBlueOceanFetcher(),
  'collect-it': () => createCollectItFetcher(),
};

/**
 * The collection every shop is checked for. The shop parsers still read series 3 rules only
 * (blue-ocean "On Fire" titles, eBay series words, sammel-ente's series 3 category), so binding a
 * fetcher to another collection would store series 3 listings under it; per-collection shop
 * settings come with the next collections.
 */
const COLLECTION: CollectionId = legoMinecraft3.id;

function forCollection(fetcher: ShopFetcher, collection: CollectionId): ShopAdapter {
  return { id: fetcher.id, collection, fetchListings: () => fetcher.fetchListings() };
}

/**
 * Throws when a shop has two adapters. The run summary, a shop's recent peak and the shop
 * alert keys (`shop-error:<shop>`, ...) are keyed per shop, so a second adapter of one shop
 * (another collection) would overwrite or throttle the first one's; key them per collection
 * before allowing it.
 */
export function checkOneAdapterPerShop(adapters: ShopAdapter[]): ShopAdapter[] {
  const seen = new Set<ShopId>();
  for (const a of adapters) {
    if (seen.has(a.id)) throw new Error(`two adapters for shop ${a.id}`);
    seen.add(a.id);
  }
  return adapters;
}

/**
 * The shops this process checks, in SHOP_IDS order: every shop, plus eBay when its credentials
 * are set, each for `lego-minecraft-3`. `/missing status` shows the shops left out as not
 * enabled. `cardNames(collection)` gives eBay that collection's catalog names for titles
 * without a series word (read at the start of each eBay fetch, so after sammel-ente has updated
 * them in the same round).
 */
export function createShopAdapters(
  ebay: Config['ebay'],
  cardNames?: (collection: CollectionId) => ReadonlyMap<CardId, string>
): ShopAdapter[] {
  if (!ebay) logger.warn('eBay disabled: EBAY_CLIENT_ID/EBAY_CLIENT_SECRET not set');
  return checkOneAdapterPerShop(
    SHOP_IDS.flatMap((id): ShopAdapter[] => {
      if (id !== 'ebay') return [forCollection(SHOP_FACTORIES[id](), COLLECTION)];
      if (!ebay) return [];
      const names = cardNames ? { cardNames: () => cardNames(COLLECTION) } : {};
      return [forCollection(createEbayFetcher({ ...ebay, ...names }), COLLECTION)];
    })
  );
}
