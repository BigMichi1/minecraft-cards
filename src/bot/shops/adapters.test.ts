import { describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
import { checkAdapters, createShopAdapters, enabledShopsOf } from './adapters';
import { legoMinecraft1 } from '../collections/legoMinecraft1';
import type { CollectionId } from '../collections/ids';

/** Runs `fn` with `logger.warn` spied, and returns what it returned plus the warned messages. */
function withWarnings<T>(fn: () => T): { value: T; warned: string[] } {
  const warn = spyOn(logger, 'warn');
  try {
    const value = fn();
    return { value, warned: warn.mock.calls.map((c) => String(c[0])) };
  } finally {
    warn.mockRestore();
  }
}

describe('createShopAdapters', () => {
  const key = (a: { id: string; collection: string }) => `${a.id}:${a.collection}`;

  test('one adapter per collection and shop, in collection then shop order, eBay last', () => {
    const { value, warned } = withWarnings(() => createShopAdapters(null));
    expect(value.map(key)).toEqual([
      'sammel-ente:lego-minecraft-1',
      'collect-it:lego-minecraft-1',
      'sammel-ente:lego-minecraft-2',
      'sammel-ente:lego-minecraft-3',
      'blue-ocean:lego-minecraft-3',
      'collect-it:lego-minecraft-3',
    ]);
    expect(warned.some((w) => w.includes('eBay disabled'))).toBe(true);
  });

  test('with eBay credentials, one eBay adapter covers every collection, and no warning', () => {
    const { value, warned } = withWarnings(() =>
      createShopAdapters({ clientId: 'id', clientSecret: 'secret' })
    );
    const ebay = value.filter((a) => a.id === 'ebay');
    expect(ebay).toHaveLength(1);
    expect(ebay[0]!.collections).toEqual([
      'lego-minecraft-1',
      'lego-minecraft-2',
      'lego-minecraft-3',
    ]);
    expect(enabledShopsOf(value).get('lego-minecraft-2')).toEqual(['sammel-ente', 'ebay']);
    expect(warned.some((w) => w.includes('eBay disabled'))).toBe(false);
  });

  test('a second adapter of one shop and collection is refused', () => {
    const fetcher = { id: 'blue-ocean' as const, fetchListings: async () => ({ listings: [] }) };
    const a = { ...fetcher, collection: 'lego-minecraft-3' as const };
    const b = { ...fetcher, collection: 'lego-minecraft-1' as const };
    expect(() => checkAdapters([a, { ...a }])).toThrow(
      'two adapters for shop blue-ocean in lego-minecraft-3'
    );
    expect(checkAdapters([a, b])).toEqual([a, b]);
  });

  test('a shared run is refused when it overlaps another adapter or does not cover its own collection once', () => {
    const fetcher = { id: 'ebay' as const, fetchListings: async () => ({ listings: [] }) };
    const shared = {
      ...fetcher,
      collection: 'lego-minecraft-3' as const,
      collections: ['lego-minecraft-1', 'lego-minecraft-3'] as const,
    };
    const single = { ...fetcher, collection: 'lego-minecraft-1' as const };
    expect(() => checkAdapters([shared, single])).toThrow(
      'two adapters for shop ebay in lego-minecraft-1'
    );
    expect(() =>
      checkAdapters([{ ...shared, collections: ['lego-minecraft-1'] as const }])
    ).toThrow('covers lego-minecraft-1, not lego-minecraft-3 once');
    expect(() =>
      checkAdapters([{ ...shared, collections: ['lego-minecraft-3', 'lego-minecraft-3'] as const }])
    ).toThrow('not lego-minecraft-3 once');
    expect(() => checkAdapters([{ ...shared, collections: [] as const }])).toThrow('once');
  });

  test('eBay settings without a search, or with a stateful marker, are refused at start', () => {
    const creds = { clientId: 'id', clientSecret: 's' };
    const noSearch = { ...legoMinecraft1, shops: { ebay: { queries: [], series: /Serie 1/i } } };
    expect(() => createShopAdapters(creds, undefined, { collections: [noSearch] })).toThrow(
      'lego-minecraft-1: eBay settings without a search'
    );
    const global = { ...legoMinecraft1, shops: { ebay: { queries: ['q'], series: /Serie 1/gi } } };
    expect(() => createShopAdapters(creds, undefined, { collections: [global] })).toThrow(
      'must not use the g or y flag'
    );
  });

  test('without a collection on eBay there is no eBay adapter; without series 3 the first one files the counts', () => {
    const creds = { clientId: 'id', clientSecret: 's' };
    const off = { ...legoMinecraft1, shops: {} };
    expect(createShopAdapters(creds, undefined, { collections: [off] })).toEqual([]);
    const [ebay] = createShopAdapters(creds, undefined, {
      collections: [{ ...legoMinecraft1, shops: { ebay: legoMinecraft1.shops.ebay! } }],
    });
    expect(ebay).toMatchObject({ id: 'ebay', collection: 'lego-minecraft-1' });
    expect(ebay!.collections).toEqual(['lego-minecraft-1']);
  });

  test('a category on another host than its shop is refused at start', () => {
    const bad = {
      ...legoMinecraft1,
      shops: {
        'sammel-ente': { category: 'https://sammel-ente.de/Minecraft/Serie-1/', series: 'Serie 1' },
      },
    };
    expect(() => createShopAdapters(null, undefined, { collections: [bad] })).toThrow(
      'lego-minecraft-1: sammel-ente category is on sammel-ente.de, not shop-sammel-ente.de'
    );
  });

  test('blue-ocean or eBay for another collection than series 3 is refused at start', () => {
    const bad = { ...legoMinecraft1, shops: { 'blue-ocean': {} } };
    expect(() => createShopAdapters(null, undefined, { collections: [bad] })).toThrow(
      'lego-minecraft-1: blue-ocean is read for lego-minecraft-3 only'
    );
  });

  test('a collect-it category on another host is refused', () => {
    const host = {
      ...legoMinecraft1,
      shops: {
        'collect-it': { category: 'https://collect-it.de/x/Einzelkarten', series: 'Serie 1' },
      },
    };
    expect(() => createShopAdapters(null, undefined, { collections: [host] })).toThrow(
      'lego-minecraft-1: collect-it category is on collect-it.de, not www.collect-it.de'
    );
  });

  test('without a fetch given, the shops are read with the global fetch', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'));
    try {
      const adapters = withWarnings(() => createShopAdapters(null)).value;
      await adapters[0]!.fetchListings().catch(() => undefined);
      expect(spy.mock.calls[0]?.[0]).toBe('https://shop-sammel-ente.de/Minecraft/Serie-1/?p=1');
    } finally {
      spy.mockRestore();
    }
  });

  test('enabledShopsOf lists the shops checked per collection', () => {
    const enabled = enabledShopsOf(withWarnings(() => createShopAdapters(null)).value);
    expect(enabled.get('lego-minecraft-1')).toEqual(['sammel-ente', 'collect-it']);
    expect(enabled.get('lego-minecraft-2')).toEqual(['sammel-ente']);
    expect(enabled.get('lego-minecraft-3')).toEqual(['sammel-ente', 'blue-ocean', 'collect-it']);
  });

  test('collect-it is paced across collections, and two shops do not pace each other', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const deps = {
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    };
    // The pacers are internal: drive them through the fetch they wrap.
    const seen: string[] = [];
    const adapters = createShopAdapters(null, undefined, {
      ...deps,
      fetchFn: async (url) => {
        seen.push(url);
        throw new Error('stop');
      },
    });
    const of = (shop: string, collection: string) =>
      adapters.find((a) => a.id === shop && a.collection === collection)!;
    await of('collect-it', 'lego-minecraft-1')
      .fetchListings()
      .catch(() => undefined);
    await of('sammel-ente', 'lego-minecraft-1')
      .fetchListings()
      .catch(() => undefined);
    await of('collect-it', 'lego-minecraft-3')
      .fetchListings()
      .catch(() => undefined);
    expect(seen).toHaveLength(3);
    // Only the second collect-it request waited; sammel-ente in between did not.
    expect(sleeps).toEqual([1500]);
  });

  test('fetchers of one shop share one pacer, across collections', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const page = (series: number) =>
      `<div class="card product-box"><a class="product-name" href="/x${series}">LEGO Minecraft Serie ${series} | #001 Steve</a></div>`;
    const adapters = createShopAdapters(null, undefined, {
      fetchFn: async (url) => new Response(page(url.includes('Serie-1') ? 1 : 2)),
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    const of = (collection: string) =>
      adapters.find((a) => a.id === 'sammel-ente' && a.collection === collection)!;
    await of('lego-minecraft-1').fetchListings();
    clock += 200;
    await of('lego-minecraft-2').fetchListings();
    expect(sleeps).toEqual([1300]);
  });

  test('passes the catalog names on to eBay, read only when eBay fetches', async () => {
    let reads = 0;
    const asked: string[] = [];
    const cardNames = (collection: CollectionId) => {
      reads++;
      asked.push(collection);
      return new Map();
    };
    const adapters = createShopAdapters({ clientId: 'id', clientSecret: 'secret' }, cardNames);
    expect(reads).toBe(0);
    // The token request fails; the names are read before it, at the start of the fetch.
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 500 })
    );
    try {
      await adapters
        .find((a) => a.id === 'ebay')!
        .fetchListings()
        .catch(() => undefined);
    } finally {
      fetchSpy.mockRestore();
    }
    // One read per collection, at the start of the one eBay fetch.
    expect(reads).toBe(3);
    expect(asked).toEqual(['lego-minecraft-3', 'lego-minecraft-1', 'lego-minecraft-2']);
  });
});
