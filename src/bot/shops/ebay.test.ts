import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
import { createEbayAdapter, extractCardIdsFromTitle, EBAY_QUERIES } from './ebay';
import { HttpError } from '../utils/http';
import { readFixture } from '../../test/shopHelpers';
import { ShopLayoutError, type FetchFn } from './types';
import { cid, ids } from '../../test/cardIds';

describe('extractCardIdsFromTitle', () => {
  test('reads prefixed numbers', () => {
    expect(extractCardIdsFromTitle('LEGO Minecraft On Fire Karte Nr. 12 Squid')).toEqual([
      cid('12'),
    ]);
    expect(extractCardIdsFromTitle('Karte Nr.12')).toEqual([cid('12')]);
    expect(extractCardIdsFromTitle('Card No. 7')).toEqual([cid('7')]);
    expect(extractCardIdsFromTitle('Karte 012')).toEqual([cid('12')]);
    expect(extractCardIdsFromTitle('Card 5')).toEqual([cid('5')]);
  });

  test('reads bundles, LE and XXL ids', () => {
    expect(extractCardIdsFromTitle('Lego Minecraft TCC Serie 3 #12, #45 und LE8')).toEqual(
      ids('12', '45', 'LE8')
    );
    expect(extractCardIdsFromTitle('LE 08 und XXL1')).toEqual(ids('LE8', 'XXL1'));
    expect(extractCardIdsFromTitle('Nr. 12, 45 und 107')).toEqual(ids('12', '45', '107'));
  });

  test('takes the card number of a 12/228 title and ignores bare numbers', () => {
    expect(extractCardIdsFromTitle('Minecraft Serie 3 Karte 107/228 2026')).toEqual([cid('107')]);
    expect(extractCardIdsFromTitle('Squid 12/228')).toEqual([cid('12')]);
    expect(extractCardIdsFromTitle('LEGO Minecraft Serie 3 Booster 2026')).toEqual([]);
    expect(extractCardIdsFromTitle('Sammlung 228 Karten')).toEqual([]);
  });

  test('prices, counts and sizes after a prefix are not ids', () => {
    expect(extractCardIdsFromTitle('Karte 1,50 €')).toEqual([cid('1')]);
    expect(extractCardIdsFromTitle('Nr. 12, 3er Set')).toEqual([cid('12')]);
    expect(extractCardIdsFromTitle('Karte 12 und 3 weitere')).toEqual([cid('12')]);
    expect(extractCardIdsFromTitle('Karte 3er Set')).toEqual([]);
    expect(extractCardIdsFromTitle('Nr. 1er')).toEqual([]);
    expect(extractCardIdsFromTitle('11/2026 neu')).toEqual([]);
    expect(extractCardIdsFromTitle('Größe 10/12')).toEqual([]);
  });

  test('dedupes and sorts', () => {
    expect(extractCardIdsFromTitle('LE8 #45 #12 Nr. 12')).toEqual(ids('12', '45', 'LE8'));
  });
});

function makeFetch(
  options: {
    tokenStatus?: number;
    /** Token answer body; defaults to the fixture. */
    tokenBody?: string;
    searchStatus?: number;
    /** Body of the n-th search request (0-based); defaults to the fixture. */
    searchBody?: (n: number) => string;
  } = {}
): {
  fetchFn: FetchFn;
  tokenCalls: number;
  searchUrls: string[];
  inits: RequestInit[];
} {
  const state = { tokenCalls: 0, searchUrls: [] as string[], inits: [] as RequestInit[] };
  const fetchFn: FetchFn = async (url, init) => {
    state.inits.push(init ?? {});
    if (url.includes('/identity/v1/oauth2/token')) {
      state.tokenCalls++;
      return new Response(options.tokenBody ?? readFixture('ebay-token.json'), {
        status: options.tokenStatus ?? 200,
      });
    }
    const body = options.searchBody?.(state.searchUrls.length) ?? readFixture('ebay-search.json');
    state.searchUrls.push(url);
    return new Response(body, { status: options.searchStatus ?? 200 });
  };
  return {
    fetchFn,
    get tokenCalls() {
      return state.tokenCalls;
    },
    searchUrls: state.searchUrls,
    inits: state.inits,
  };
}

describe('createEbayAdapter', () => {
  test('maps listings, skips items without ids and caches the token', async () => {
    const fake = makeFetch();
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 'secret',
      fetchFn: fake.fetchFn,
    });
    const { listings, skippedNoId, skippedInvalid } = await adapter.fetchListings();
    expect(listings).toHaveLength(4);
    expect(skippedNoId).toBe(1);
    expect(skippedInvalid).toBe(0);
    expect(fake.tokenCalls).toBe(1);
    expect(fake.searchUrls).toHaveLength(EBAY_QUERIES.length);

    expect(listings.find((l) => l.format === 'auction')).toMatchObject({
      shop: 'ebay',
      cardIds: ['107'],
      cardName: null,
      idConflict: false,
      available: true,
      price: { cents: 149 + 160, currency: 'EUR' },
      auctionEndsAt: Date.parse('2026-11-20T18:30:00.000Z'),
      url: 'https://www.ebay.de/itm/110000000003',
    });
    // No legacyItemId on this item: the number comes from the middle of `v1|<n>|0`.
    expect(listings.find((l) => l.cardIds.includes(cid('LE8')))).toMatchObject({
      format: 'fixed_price',
      cardIds: ['12', '45', 'LE8'],
      price: { cents: 599, currency: 'EUR' },
      auctionEndsAt: null,
      imageUrl: 'https://i.ebayimg.com/images/g/bbb/s-l225.jpg',
    });
    const noImage = listings.find((l) => l.url.endsWith('110000000005'))!;
    expect(noImage.imageUrl).toBeNull();
    expect(noImage.price).toEqual({ cents: 200, currency: 'EUR' });
    expect(noImage.cardIds).toEqual([cid('107')]);
    expect(noImage.url).toBe('https://www.ebay.de/itm/110000000005');
    for (const l of listings) expect(l.url).not.toContain('?');
  });

  const item = (over: Record<string, unknown>) => ({
    itemId: 'v1|220000000001|0',
    legacyItemId: '220000000001',
    title: 'LEGO Minecraft Karte Nr. 12',
    itemWebUrl: 'https://www.ebay.de/itm/220000000001?hash=item1:g:x&amdata=enc%3Afirst',
    price: { value: '1.00', currency: 'EUR' },
    buyingOptions: ['FIXED_PRICE'],
    ...over,
  });
  const body = (...items: object[]) => JSON.stringify({ itemSummaries: items });

  test('the same item from two searches with different tracking data is one listing', async () => {
    const fake = makeFetch({
      searchBody: (n) =>
        body(
          item({
            itemWebUrl: `https://www.ebay.de/itm/220000000001?hash=item1:g:x&amdata=enc%3Asearch${n}`,
          })
        ),
    });
    const adapter = createEbayAdapter({ clientId: 'id', clientSecret: 's', fetchFn: fake.fetchFn });
    const first = (await adapter.fetchListings()).listings;
    const second = (await adapter.fetchListings()).listings;
    expect(first.map((l) => l.url)).toEqual(['https://www.ebay.de/itm/220000000001']);
    expect(second.map((l) => l.url)).toEqual(first.map((l) => l.url));
  });

  test('without any item id the web url is used without its query string', async () => {
    const fake = makeFetch({
      searchBody: () =>
        body(
          item({
            itemId: undefined,
            legacyItemId: undefined,
            itemWebUrl: 'https://www.ebay.de/itm/330000000001?hash=h&amdata=enc%3Ax',
          })
        ),
    });
    const adapter = createEbayAdapter({ clientId: 'id', clientSecret: 's', fetchFn: fake.fetchFn });
    expect((await adapter.fetchListings()).listings.map((l) => l.url)).toEqual([
      'https://www.ebay.de/itm/330000000001',
    ]);
  });

  test('every search returning zero items is a layout error', async () => {
    const fake = makeFetch({ searchBody: () => JSON.stringify({ total: 0 }) });
    const adapter = createEbayAdapter({ clientId: 'id', clientSecret: 's', fetchFn: fake.fetchFn });
    await expect(adapter.fetchListings()).rejects.toBeInstanceOf(ShopLayoutError);
  });

  test('one search with items is enough, even when none of them names a card', async () => {
    const fake = makeFetch({
      searchBody: (n) => (n === 1 ? body(item({ title: 'LEGO Minecraft Booster' })) : body()),
    });
    const adapter = createEbayAdapter({ clientId: 'id', clientSecret: 's', fetchFn: fake.fetchFn });
    expect(await adapter.fetchListings()).toEqual({
      listings: [],
      skippedNoId: 1,
      skippedInvalid: 0,
    });
  });

  test('sends marketplace, auth and user agent headers', async () => {
    const fake = makeFetch();
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 'secret',
      fetchFn: fake.fetchFn,
    });
    await adapter.fetchListings();
    const tokenHeaders = fake.inits[0]!.headers as Record<string, string>;
    expect(tokenHeaders.Authorization).toBe(`Basic ${btoa('id:secret')}`);
    expect(fake.inits[0]!.method).toBe('POST');
    const searchHeaders = fake.inits[1]!.headers as Record<string, string>;
    expect(searchHeaders['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_DE');
    expect(searchHeaders['User-Agent']).toContain('minecraft-cards-bot');
    expect(fake.searchUrls[0]).toContain('limit=200');
  });

  test('a token failure throws HttpError without leaking the secret', async () => {
    const fake = makeFetch({ tokenStatus: 401 });
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 'topsecret',
      fetchFn: fake.fetchFn,
    });
    const error = await adapter.fetchListings().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(401);
    expect((error as HttpError).message).not.toContain('topsecret');
  });

  test("a token failure names eBay's error but no other field of the answer", async () => {
    const fake = makeFetch({
      tokenStatus: 401,
      tokenBody: JSON.stringify({
        error: 'invalid_client',
        error_description: 'client authentication failed for topsecret',
        access_token: 'v^1.1#leaked',
      }),
    });
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 'topsecret',
      fetchFn: fake.fetchFn,
    });
    const error = (await adapter.fetchListings().catch((e: unknown) => e)) as HttpError;
    expect(error.message).toContain('invalid_client');
    expect(error.message).toContain('[redacted]');
    expect(error.message).not.toContain('topsecret');
    expect(error.message).not.toContain('leaked');
  });

  test("a search failure keeps at most 300 characters of eBay's error message", async () => {
    const fake = makeFetch({
      searchStatus: 400,
      searchBody: () =>
        JSON.stringify({ errors: [{ longMessage: `bad query ${'x'.repeat(500)}` }] }),
    });
    const adapter = createEbayAdapter({ clientId: 'id', clientSecret: 's', fetchFn: fake.fetchFn });
    const error = (await adapter.fetchListings().catch((e: unknown) => e)) as HttpError;
    expect(error).toBeInstanceOf(HttpError);
    expect(error.message).toContain('bad query');
    expect(error.message).toContain(fake.searchUrls[0]!);
    expect(error.message.length).toBeLessThan(fake.searchUrls[0]!.length + 340);
  });

  test('an answer that is not JSON names the URL', async () => {
    const fake = makeFetch({ searchBody: () => '<html>maintenance</html>' });
    const adapter = createEbayAdapter({ clientId: 'id', clientSecret: 's', fetchFn: fake.fetchFn });
    const error = (await adapter.fetchListings().catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('not JSON');
    expect(error.message).toContain('item_summary/search');
  });

  test('a search answer with errors and no items throws', async () => {
    const fake = makeFetch({
      searchBody: () => JSON.stringify({ errors: [{ message: 'Invalid category' }] }),
    });
    const adapter = createEbayAdapter({ clientId: 'id', clientSecret: 's', fetchFn: fake.fetchFn });
    await expect(adapter.fetchListings()).rejects.toThrow('Invalid category');
  });

  test('warns when a search has more results than it returned', async () => {
    const warn = spyOn(logger, 'warn');
    try {
      const fake = makeFetch({
        searchBody: () => JSON.stringify({ total: 450, itemSummaries: [item({})] }),
      });
      const adapter = createEbayAdapter({
        clientId: 'id',
        clientSecret: 's',
        fetchFn: fake.fetchFn,
      });
      await adapter.fetchListings();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('450 results'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('items without a usable link or title are counted as invalid', async () => {
    const fake = makeFetch({
      searchBody: () =>
        body(
          item({}),
          item({ title: undefined }),
          item({ itemId: undefined, legacyItemId: undefined, itemWebUrl: undefined })
        ),
    });
    const adapter = createEbayAdapter({ clientId: 'id', clientSecret: 's', fetchFn: fake.fetchFn });
    const result = await adapter.fetchListings();
    expect(result.listings).toHaveLength(1);
    // Two bad items in each of the searches.
    expect(result.skippedInvalid).toBe(2 * EBAY_QUERIES.length);
  });

  describe('token expiry', () => {
    let clock: ReturnType<typeof spyOn>;
    afterEach(() => {
      clock.mockRestore();
    });

    test('a token is reused until shortly before it expires, then fetched again', async () => {
      let now = 1_000_000;
      clock = spyOn(Date, 'now').mockImplementation(() => now);
      const fake = makeFetch({
        tokenBody: JSON.stringify({ access_token: 't', expires_in: 7200 }),
      });
      const adapter = createEbayAdapter({
        clientId: 'id',
        clientSecret: 's',
        fetchFn: fake.fetchFn,
      });
      await adapter.fetchListings();
      now += 60 * 60 * 1000;
      await adapter.fetchListings();
      expect(fake.tokenCalls).toBe(1);
      // 7200 s minus the 60 s safety margin.
      now = 1_000_000 + 7140 * 1000;
      await adapter.fetchListings();
      expect(fake.tokenCalls).toBe(2);
    });
  });

  describe('prices', () => {
    const priceOf = async (over: Record<string, unknown>) => {
      const fake = makeFetch({ searchBody: () => body(item(over)) });
      const adapter = createEbayAdapter({
        clientId: 'id',
        clientSecret: 's',
        fetchFn: fake.fetchFn,
      });
      return (await adapter.fetchListings()).listings[0]!.price;
    };

    test('shipping in another currency is not added', async () => {
      expect(
        await priceOf({
          price: { value: '1.00', currency: 'EUR' },
          shippingOptions: [{ shippingCost: { value: '3.00', currency: 'GBP' } }],
        })
      ).toEqual({ cents: 100, currency: 'EUR' });
    });

    test('one decimal and extra decimals are read without float rounding', async () => {
      expect(await priceOf({ price: { value: '1.5', currency: 'EUR' } })).toEqual({
        cents: 150,
        currency: 'EUR',
      });
      expect(await priceOf({ price: { value: '1.499', currency: 'EUR' } })).toEqual({
        cents: 149,
        currency: 'EUR',
      });
    });
  });

  test('a search failure throws HttpError', async () => {
    const fake = makeFetch({ searchStatus: 500 });
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 'secret',
      fetchFn: fake.fetchFn,
    });
    await expect(adapter.fetchListings()).rejects.toBeInstanceOf(HttpError);
  });
});
