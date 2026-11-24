import { describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
import { checkOneAdapterPerShopAndCollection, createShopAdapters } from './adapters';
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

  test('one adapter per collection and shop, in collection then shop order', () => {
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

  test('with eBay credentials, eBay checks series 3, and no warning', () => {
    const { value, warned } = withWarnings(() =>
      createShopAdapters({ clientId: 'id', clientSecret: 'secret' })
    );
    expect(value.map(key).at(-1)).toBe('ebay:lego-minecraft-3');
    expect(value.filter((a) => a.id === 'ebay')).toHaveLength(1);
    expect(warned.some((w) => w.includes('eBay disabled'))).toBe(false);
  });

  test('a second adapter of one shop and collection is refused', () => {
    const fetcher = { id: 'blue-ocean' as const, fetchListings: async () => ({ listings: [] }) };
    const a = { ...fetcher, collection: 'lego-minecraft-3' as const };
    const b = { ...fetcher, collection: 'lego-minecraft-1' as const };
    expect(() => checkOneAdapterPerShopAndCollection([a, { ...a }])).toThrow(
      'two adapters for shop blue-ocean in lego-minecraft-3'
    );
    expect(checkOneAdapterPerShopAndCollection([a, b])).toEqual([a, b]);
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
    expect(reads).toBe(1);
    expect(asked).toEqual(['lego-minecraft-3']);
  });
});
