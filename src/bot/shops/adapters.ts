import type { CardId } from '../cards/cardId';
import type { CollectionDefinition, CollectionId } from '../collections/ids';
import { COLLECTIONS } from '../collections/index';
import type { Config } from '../config';
import logger from '../utils/logger';
import { createPacedFetch } from '../utils/pacedFetch';
import { createBlueOceanFetcher } from './blueOcean';
import { createCollectItFetcher } from './collectIt';
import { createEbayFetcher } from './ebay';
import { createSammelEnteFetcher } from './sammelEnte';
import { SHOP_IDS, type FetchFn, type ShopAdapter, type ShopFetcher, type ShopId } from './types';

/** Between two page requests to one shop, also across collections (CLAUDE.md, shop requests). */
const SHOP_DELAY_MS = 1500;

/** Each shop's host: every fetcher of one shop shares one pacer for it. */
const SHOP_HOSTS: Record<Exclude<ShopId, 'ebay'>, string> = {
  'sammel-ente': 'shop-sammel-ente.de',
  'blue-ocean': 'www.blue-ocean.de',
  'collect-it': 'www.collect-it.de',
};

/** Test seams: the fetch the pacers wrap, and their clock. */
export interface AdapterDeps {
  fetchFn?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The fetcher of `shop` for `definition`, or null when the collection does not list the shop.
 * A `ShopId` missing here is a compile error, so a new shop cannot be left out by accident.
 */
function fetcherFor(
  shop: Exclude<ShopId, 'ebay'>,
  definition: CollectionDefinition,
  fetchFn: FetchFn
): ShopFetcher | null {
  switch (shop) {
    case 'sammel-ente': {
      const settings = definition.shops['sammel-ente'];
      return settings ? createSammelEnteFetcher(settings, fetchFn) : null;
    }
    case 'collect-it': {
      const settings = definition.shops['collect-it'];
      return settings ? createCollectItFetcher(settings, fetchFn) : null;
    }
    case 'blue-ocean':
      return definition.shops['blue-ocean'] ? createBlueOceanFetcher(fetchFn) : null;
  }
}

function forCollection(fetcher: ShopFetcher, collection: CollectionId): ShopAdapter {
  return { id: fetcher.id, collection, fetchListings: () => fetcher.fetchListings() };
}

/**
 * Throws when a shop has two adapters for one collection: the run summary, a shop's recent peak
 * and the shop alert keys are keyed per (shop, collection).
 */
export function checkOneAdapterPerShopAndCollection(adapters: ShopAdapter[]): ShopAdapter[] {
  const seen = new Set<string>();
  for (const a of adapters) {
    const key = `${a.id}:${a.collection}`;
    if (seen.has(key)) throw new Error(`two adapters for shop ${a.id} in ${a.collection}`);
    seen.add(key);
  }
  return adapters;
}

/**
 * The shops this process checks: per collection (COLLECTIONS order), the shops its definition
 * lists (SHOP_IDS order), eBay only when its credentials are set. The fetchers of one shop share
 * one paced fetch, so its pages stay SHOP_DELAY_MS apart across collections too.
 * `cardNames(collection)` gives eBay that collection's catalog names for titles without a series
 * word (read at the start of each eBay fetch, after the catalog sync of the same round).
 */
export function createShopAdapters(
  ebay: Config['ebay'],
  cardNames?: (collection: CollectionId) => ReadonlyMap<CardId, string>,
  deps: AdapterDeps = {}
): ShopAdapter[] {
  if (!ebay) logger.warn('eBay disabled: EBAY_CLIENT_ID/EBAY_CLIENT_SECRET not set');
  const base: FetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
  const pacers = new Map<string, FetchFn>();
  const pacedFor = (shop: Exclude<ShopId, 'ebay'>): FetchFn => {
    let paced = pacers.get(shop);
    if (!paced) {
      paced = createPacedFetch(base, new Set([SHOP_HOSTS[shop]]), SHOP_DELAY_MS, {
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      });
      pacers.set(shop, paced);
    }
    return paced;
  };
  return checkOneAdapterPerShopAndCollection(
    COLLECTIONS.flatMap((definition) =>
      SHOP_IDS.flatMap((shop): ShopAdapter[] => {
        if (shop === 'ebay') {
          if (!ebay || !definition.shops.ebay) return [];
          const collection = definition.id;
          const names = cardNames ? { cardNames: () => cardNames(collection) } : {};
          return [forCollection(createEbayFetcher({ ...ebay, ...names }), collection)];
        }
        const fetcher = fetcherFor(shop, definition, pacedFor(shop));
        return fetcher ? [forCollection(fetcher, definition.id)] : [];
      })
    )
  );
}
