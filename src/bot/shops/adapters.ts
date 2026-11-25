import {
  MINECRAFT_CARD_IDS,
  TURBO_ATTAX_CARD_IDS,
  type CardId,
  type CardIdRule,
} from '../cards/cardId';
import {
  LEGACY_COLLECTION,
  type CollectionDefinition,
  type CollectionId,
} from '../collections/ids';
import { COLLECTIONS } from '../collections/index';
import type { Config } from '../config';
import logger from '../utils/logger';
import { createPacedFetch } from '../utils/pacedFetch';
import { blueOceanCollectionsOf, createBlueOceanFetcher } from './blueOcean';
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
 * skip the shop's pacer), blue-ocean settings without a product code (its root-URL cards would
 * never be placed, all of series 3's), with one that is not lowercase letters and digits (it is put
 * into a regular expression and compared with lowercased URLs), with an empty picture part (in
 * every file name), an empty category path or one holding `/` (never matched, yet it makes the
 * collection read titles by `Nummer`), or with a `g`/`y` title or exclusion marker, or eBay
 * settings without a search (the collection's listings would be marked gone, never searched),
 * with a `g`/`y` marker or exclusion pattern (`test` would keep state between titles), or with a
 * page cap that is not a whole number from 1 to 50 (eBay takes no offset beyond 10000).
 */
function checkSettings(definition: CollectionDefinition): void {
  checkIdRule(definition);
  for (const shop of ['sammel-ente', 'collect-it'] as const) {
    const settings = definition.shops[shop];
    if (!settings) continue;
    // collect-it titles end with `Serie N` or a year; sammel-ente's name `Serie N` before their pipe.
    const label = shop === 'collect-it' ? /^(?:Serie \d+|(?:19|20)\d{2})$/ : /^Serie \d+$/;
    if (!label.test(settings.series)) {
      throw new Error(
        `${definition.id}: the ${shop} series label must be "Serie N"${shop === 'collect-it' ? ' or a year' : ''}`
      );
    }
    const host = new URL(settings.category).hostname;
    if (host !== SHOP_HOSTS[shop]) {
      throw new Error(`${definition.id}: ${shop} category is on ${host}, not ${SHOP_HOSTS[shop]}`);
    }
  }
  const blueOcean = definition.shops['blue-ocean'];
  // Checked apart from the pattern below only for the clearer message.
  if (blueOcean && blueOcean.productCode.length === 0) {
    throw new Error(`${definition.id}: blue-ocean settings without a product code`);
  }
  if (blueOcean && !/^[a-z0-9]+$/.test(blueOcean.productCode)) {
    throw new Error(
      `${definition.id}: the blue-ocean product code must be lowercase letters and digits`
    );
  }
  if (
    blueOcean &&
    (blueOcean.picture === '' ||
      blueOcean.categoryPath === '' ||
      (blueOcean.categoryPath?.includes('/') ?? false))
  ) {
    throw new Error(
      `${definition.id}: blue-ocean settings with an empty picture or an empty or multi-segment category path`
    );
  }
  for (const marker of [blueOcean?.title, blueOcean?.excludes]) {
    if (marker && (marker.global || marker.sticky)) {
      throw new Error(
        `${definition.id}: the blue-ocean title or exclusion marker must not use the g or y flag`
      );
    }
  }
  const ebay = definition.shops.ebay;
  if (ebay && ebay.queries.length === 0) {
    throw new Error(`${definition.id}: eBay settings without a search`);
  }
  if (ebay && (ebay.series.global || ebay.series.sticky)) {
    throw new Error(`${definition.id}: the eBay series marker must not use the g or y flag`);
  }
  if (ebay?.excludes && (ebay.excludes.global || ebay.excludes.sticky)) {
    throw new Error(`${definition.id}: the eBay exclusion pattern must not use the g or y flag`);
  }
  if (
    ebay?.maxPages !== undefined &&
    !(Number.isInteger(ebay.maxPages) && ebay.maxPages >= 1 && ebay.maxPages <= 50)
  ) {
    throw new Error(`${definition.id}: the eBay page cap must be a whole number from 1 to 50`);
  }
}

/**
 * Throws when two collections share a blue-ocean product code or category path, or when one's
 * picture part contains another's (compared lowercase, as the parser does): the walk would place
 * every product of the later one in the earlier one, or exclude both.
 */
function checkDistinctBlueOcean(definitions: readonly CollectionDefinition[]): void {
  for (const field of ['productCode', 'categoryPath', 'picture'] as const) {
    const seen: [string, CollectionId][] = [];
    for (const d of definitions) {
      const raw = d.shops['blue-ocean']?.[field];
      if (raw === undefined) continue;
      const value = field === 'picture' ? raw.toLowerCase() : raw;
      const clash = seen.find(([v]) =>
        field === 'picture' ? v.includes(value) || value.includes(v) : v === value
      );
      if (clash) {
        throw new Error(
          `${d.id}: blue-ocean ${field} "${raw}" overlaps ${clash[1]}'s "${clash[0]}"`
        );
      }
      seen.push([value, d.id]);
    }
  }
}

/** Whether two rules accept the same ids (the same prefixes and code families). */
function sameRule(a: CardIdRule, b: CardIdRule): boolean {
  const key = (r: CardIdRule) =>
    JSON.stringify([[...r.prefixes].sort(), [...(r.codes ?? [])].sort()]);
  return key(a) === key(b);
}

/** The id rule each eBay title form reads (`ebay.ts` readIdsIn, `ebayTurboAttax.ts`). */
const FORM_RULES = { minecraft: MINECRAFT_CARD_IDS, 'turbo-attax': TURBO_ATTAX_CARD_IDS } as const;

/**
 * Throws for a card id rule the parser would silently never match (a prefix that is not
 * uppercase letters, a code family that is not two of them, a repeat), Kleinanzeigen search
 * words that are not one lowercase dash-joined path segment, and shop settings whose title
 * reader reads another rule than the collection's: sammel-ente and blue-ocean read LEGO
 * Minecraft ids only, and eBay's `idForms` reads its own rule.
 */
function checkIdRule(definition: CollectionDefinition): void {
  const { id, cardIds: rule, shops } = definition;
  const codes = rule.codes ?? [];
  if (
    !rule.prefixes.every((p) => /^[A-Z]+$/.test(p)) ||
    !codes.every((c) => /^[A-Z]{2}$/.test(c)) ||
    new Set(rule.prefixes).size !== rule.prefixes.length ||
    new Set(codes).size !== codes.length
  ) {
    throw new Error(
      `${id}: the card id rule needs distinct uppercase prefixes and two-letter code families`
    );
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(definition.kleinanzeigen)) {
    throw new Error(
      `${id}: the Kleinanzeigen search words must be lowercase letters and digits joined by dashes`
    );
  }
  for (const shop of ['sammel-ente', 'blue-ocean'] as const) {
    if (shops[shop] && !sameRule(rule, MINECRAFT_CARD_IDS)) {
      throw new Error(`${id}: ${shop} reads only LEGO Minecraft card ids`);
    }
  }
  const forms = shops.ebay?.idForms;
  if (forms && !sameRule(rule, FORM_RULES[forms])) {
    throw new Error(
      `${id}: eBay's ${forms} title forms read another id rule than the collection's`
    );
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
  shop: Exclude<ShopId, 'ebay' | 'blue-ocean'>,
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
      return settings ? createCollectItFetcher(settings, fetchFn, {}, definition.cardIds) : null;
    }
  }
}

function forCollection(fetcher: ShopFetcher, collection: CollectionId): ShopAdapter {
  return { id: fetcher.id, collection, fetchListings: () => fetcher.fetchListings() };
}

/**
 * The adapter of a run covering several collections (`collections`, from one shop's settings):
 * none when no collection has that shop's settings. The fetcher is built only then, from the
 * same list, so its collections and the adapter's cannot drift. The run's skipped counts are
 * filed under its `collection`: series 3's (the summary's `shops`) when covered, else the first.
 */
function sharedAdapters<C extends { readonly id: CollectionId }>(
  collections: readonly C[],
  fetcherFor: (collections: readonly C[]) => ShopFetcher
): ShopAdapter[] {
  const ids = collections.map((c) => c.id);
  const [first] = ids;
  if (first === undefined) return [];
  const collection = ids.includes(LEGACY_COLLECTION) ? LEGACY_COLLECTION : first;
  return [{ ...forCollection(fetcherFor(collections), collection), collections: ids }];
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
 * lists (SHOP_IDS order) but blue-ocean and eBay, then one blue-ocean adapter for every
 * collection with blue-ocean settings, then one eBay adapter for every collection with eBay
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
  checkDistinctBlueOcean(definitions);
  const perCollection = definitions.flatMap((definition) =>
    SHOP_IDS.flatMap((shop): ShopAdapter[] => {
      if (shop === 'ebay' || shop === 'blue-ocean') return [];
      const fetcher = fetcherFor(shop, definition, pacedFor(shop));
      return fetcher ? [forCollection(fetcher, definition.id)] : [];
    })
  );
  // One blue-ocean walk for every collection with blue-ocean settings: its sticker-cards category
  // lists every series, each product placed by its URL.
  const blueOceanAdapters = sharedAdapters(blueOceanCollectionsOf(definitions), (covered) =>
    createBlueOceanFetcher(pacedFor('blue-ocean'), {}, covered)
  );
  // One eBay run for every collection with eBay settings: every query is searched once, an item
  // several queries find is stored once, and each title in the collection it names.
  const ebayAdapters = ebay
    ? sharedAdapters(ebayCollectionsOf(definitions), (covered) =>
        createEbayFetcher({ ...ebay, collections: covered, ...(cardNames ? { cardNames } : {}) })
      )
    : [];
  return checkAdapters([...perCollection, ...blueOceanAdapters, ...ebayAdapters]);
}
