import type { CardId } from '../cards/cardId';
import {
  LEGACY_COLLECTION,
  type CollectionDefinition,
  type CollectionId,
} from '../collections/ids';
import { COLLECTIONS } from '../collections/index';
import type { Config } from '../config';
import logger from '../utils/logger';
import { createPacedFetch } from '../utils/pacedFetch';
import { createBlueOceanFetcher } from './blueOcean';
import { createCollectItFetcher } from './collectIt';
import { createEbayFetcher, ebayCollectionsOf } from './ebay';
import { createSammelEnteFetcher } from './sammelEnte';
import {
  SHOP_IDS,
  type EnabledShops,
  type FetchFn,
  type ShopAdapter,
  type ShopFetcher,
  type ShopId,
} from './types';

/**
 * Between two page requests to one shop, also across collections (CLAUDE.md, shop requests).
 * The fetchers keep their own 1500 ms sleep between their pages too; the pacer adds the wait
 * between one collection's last page and the next one's first (it waits only what is left).
 */
const SHOP_DELAY_MS = 1500;

/** Each shop's host: every fetcher of one shop shares one pacer for it. */
export const SHOP_HOSTS: Readonly<Record<Exclude<ShopId, 'ebay'>, string>> = {
  'sammel-ente': 'shop-sammel-ente.de',
  'blue-ocean': 'www.blue-ocean.de',
  'collect-it': 'www.collect-it.de',
};

/** Test seams: the definitions, the fetch the pacers wrap, and their clock. */
export interface AdapterDeps {
  readonly collections?: readonly CollectionDefinition[];
  readonly fetchFn?: FetchFn;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Throws for settings a run would get wrong: a category on another host than its shop (it would
 * skip the shop's pacer), blue-ocean settings without a product code (nothing would be placed in
 * the collection) or with a `g`/`y` title, or eBay settings without a search (the collection's
 * listings would be marked gone, never searched) or with a `g`/`y` marker (`test` would keep
 * state between titles).
 */
function checkSettings(definition: CollectionDefinition): void {
  for (const shop of ['sammel-ente', 'collect-it'] as const) {
    const settings = definition.shops[shop];
    if (!settings) continue;
    const host = new URL(settings.category).hostname;
    if (host !== SHOP_HOSTS[shop]) {
      throw new Error(`${definition.id}: ${shop} category is on ${host}, not ${SHOP_HOSTS[shop]}`);
    }
  }
  const blueOcean = definition.shops['blue-ocean'];
  if (blueOcean && blueOcean.productCode.length === 0) {
    throw new Error(`${definition.id}: blue-ocean settings without a product code`);
  }
  if (blueOcean?.title && (blueOcean.title.global || blueOcean.title.sticky)) {
    throw new Error(`${definition.id}: the blue-ocean title must not use the g or y flag`);
  }
  const ebay = definition.shops.ebay;
  if (ebay && ebay.queries.length === 0) {
    throw new Error(`${definition.id}: eBay settings without a search`);
  }
  if (ebay && (ebay.series.global || ebay.series.sticky)) {
    throw new Error(`${definition.id}: the eBay series marker must not use the g or y flag`);
  }
}

/** The shops checked per collection, from the adapters (`/missing status`, `/stock`, `/card`). */
export function enabledShopsOf(adapters: readonly ShopAdapter[]): EnabledShops {
  const enabled = new Map<CollectionId, ShopId[]>();
  for (const a of adapters) {
    for (const c of a.collections ?? [a.collection])
      enabled.set(c, [...(enabled.get(c) ?? []), a.id]);
  }
  return enabled;
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
      // The parser reads series 3 only until the shared walk reads every collection's settings.
      return definition.shops['blue-ocean'] && definition.id === LEGACY_COLLECTION
        ? createBlueOceanFetcher(fetchFn)
        : null;
  }
}

function forCollection(fetcher: ShopFetcher, collection: CollectionId): ShopAdapter {
  return { id: fetcher.id, collection, fetchListings: () => fetcher.fetchListings() };
}

/**
 * Throws when a shop has two adapters for one collection (the run summary, a shop's recent peak
 * and the shop alert keys are keyed per (shop, collection)), counting every collection a shared
 * run covers, or when a shared run covers no collection, one twice, or not its `collection`
 * (its skipped counts are filed there).
 */
export function checkAdapters(adapters: ShopAdapter[]): ShopAdapter[] {
  const seen = new Set<string>();
  for (const a of adapters) {
    const covered = a.collections ?? [a.collection];
    if (!covered.includes(a.collection) || new Set(covered).size !== covered.length) {
      throw new Error(`shop ${a.id}: covers ${covered.join(', ')}, not ${a.collection} once`);
    }
    for (const c of covered) {
      const key = `${a.id}:${c}`;
      if (seen.has(key)) throw new Error(`two adapters for shop ${a.id} in ${c}`);
      seen.add(key);
    }
  }
  return adapters;
}

/**
 * The shops this process checks: per collection (COLLECTIONS order), the shops its definition
 * lists (SHOP_IDS order) but eBay, then one eBay adapter for every collection with eBay
 * settings, only when its credentials are set. The fetchers of one shop share
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
  const definitions = deps.collections ?? COLLECTIONS;
  for (const definition of definitions) checkSettings(definition);
  const perCollection = definitions.flatMap((definition) =>
    SHOP_IDS.flatMap((shop): ShopAdapter[] => {
      if (shop === 'ebay') return [];
      const fetcher = fetcherFor(shop, definition, pacedFor(shop));
      return fetcher ? [forCollection(fetcher, definition.id)] : [];
    })
  );
  // One eBay run for every collection with eBay settings: every query is searched once, an item
  // several queries find is stored once, and each title in the collection it names.
  const onEbay = ebayCollectionsOf(definitions);
  const ids = onEbay.map((c) => c.id);
  const ebayAdapters: ShopAdapter[] =
    ebay && onEbay.length > 0
      ? [
          {
            ...forCollection(
              createEbayFetcher({
                ...ebay,
                collections: onEbay,
                ...(cardNames ? { cardNames } : {}),
              }),
              // The run's skipped counts are filed here: series 3's, the summary's `shops`.
              ids.includes(LEGACY_COLLECTION) ? LEGACY_COLLECTION : ids[0]!
            ),
            collections: ids,
          },
        ]
      : [];
  return checkAdapters([...perCollection, ...ebayAdapters]);
}
