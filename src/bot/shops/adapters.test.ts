import { describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
import { createShopAdapters } from './adapters';
import { SHOP_IDS } from './types';

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
  test('without eBay credentials: every other shop in SHOP_IDS order, and a warning', () => {
    const { value, warned } = withWarnings(() => createShopAdapters(null));
    expect(value.map((a) => a.id)).toEqual(SHOP_IDS.filter((id) => id !== 'ebay'));
    expect(value.map((a) => a.id)).toEqual(['sammel-ente', 'blue-ocean', 'collect-it']);
    expect(warned.some((w) => w.includes('eBay disabled'))).toBe(true);
  });

  test('with eBay credentials: every shop in SHOP_IDS order, and no warning', () => {
    const { value, warned } = withWarnings(() =>
      createShopAdapters({ clientId: 'id', clientSecret: 'secret' })
    );
    expect(value.map((a) => a.id)).toEqual([...SHOP_IDS]);
    expect(warned.some((w) => w.includes('eBay disabled'))).toBe(false);
  });

  test('passes the catalog names on to eBay, read only when eBay fetches', async () => {
    let reads = 0;
    const cardNames = () => {
      reads++;
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
  });
});
