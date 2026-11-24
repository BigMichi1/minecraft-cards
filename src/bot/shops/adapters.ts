import type { CardId } from '../cards/cardId';
import type { CollectionId } from '../collections/ids';
import type { Config } from '../config';
import logger from '../utils/logger';
import { createBlueOceanAdapter } from './blueOcean';
import { createCollectItAdapter } from './collectIt';
import { createEbayAdapter } from './ebay';
import { createSammelEnteAdapter } from './sammelEnte';
import { SHOP_IDS, type ShopAdapter, type ShopFetcher, type ShopId } from './types';

/**
 * One factory per shop that needs no credentials. A `ShopId` without an entry here is a
 * compile error, so a new shop cannot be left out of the checks by accident.
 */
const SHOP_FACTORIES: Record<Exclude<ShopId, 'ebay'>, () => ShopFetcher> = {
  'sammel-ente': () => createSammelEnteAdapter(),
  'blue-ocean': () => createBlueOceanAdapter(),
  'collect-it': () => createCollectItAdapter(),
};

/** The only collection so far: every shop checks it. */
const COLLECTION: CollectionId = 'lego-minecraft-3';

function forCollection(fetcher: ShopFetcher, collection: CollectionId): ShopAdapter {
  return { id: fetcher.id, collection, fetchListings: () => fetcher.fetchListings() };
}

/**
 * The shops this process checks, in SHOP_IDS order: every shop, plus eBay when its credentials
 * are set, each for `lego-minecraft-3`. `/missing status` shows the shops left out as not
 * enabled. `cardNames` gives eBay a collection's catalog names for titles without a series word
 * (read at the start of each eBay fetch, after sammel-ente's in the same round).
 */
export function createShopAdapters(
  ebay: Config['ebay'],
  cardNames?: (collection: CollectionId) => ReadonlyMap<CardId, string>
): ShopAdapter[] {
  if (!ebay) logger.warn('eBay disabled: EBAY_CLIENT_ID/EBAY_CLIENT_SECRET not set');
  return SHOP_IDS.flatMap((id): ShopAdapter[] => {
    if (id !== 'ebay') return [forCollection(SHOP_FACTORIES[id](), COLLECTION)];
    if (!ebay) return [];
    const names = cardNames ? { cardNames: () => cardNames(COLLECTION) } : {};
    return [forCollection(createEbayAdapter({ ...ebay, ...names }), COLLECTION)];
  });
}
