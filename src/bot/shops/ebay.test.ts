import { describe, test, expect } from 'bun:test';
import { createEbayAdapter, extractCardIdsFromTitle, EBAY_QUERIES } from './ebay';
import { HttpError } from '../utils/http';
import { readFixture } from '../../test/shopHelpers';
import { ShopLayoutError, type FetchFn } from './types';

describe('extractCardIdsFromTitle', () => {
  test('reads prefixed numbers', () => {
    expect(extractCardIdsFromTitle('LEGO Minecraft On Fire Karte Nr. 12 Squid')).toEqual(['12']);
    expect(extractCardIdsFromTitle('Karte Nr.12')).toEqual(['12']);
    expect(extractCardIdsFromTitle('Card No. 7')).toEqual(['7']);
    expect(extractCardIdsFromTitle('Karte 012')).toEqual(['12']);
    expect(extractCardIdsFromTitle('Card 5')).toEqual(['5']);
  });

  test('reads bundles, LE and XXL ids', () => {
    expect(extractCardIdsFromTitle('Lego Minecraft TCC Serie 3 #12, #45 und LE8')).toEqual([
      '12',
      '45',
      'LE8',
    ]);
    expect(extractCardIdsFromTitle('LE 08 und XXL1')).toEqual(['LE8', 'XXL1']);
    expect(extractCardIdsFromTitle('Nr. 12, 45 und 107')).toEqual(['12', '45', '107']);
  });

  test('takes the card number of a 12/228 title and ignores bare numbers', () => {
    expect(extractCardIdsFromTitle('Minecraft Serie 3 Karte 107/228 2026')).toEqual(['107']);
    expect(extractCardIdsFromTitle('Squid 12/228')).toEqual(['12']);
    expect(extractCardIdsFromTitle('LEGO Minecraft Serie 3 Booster 2026')).toEqual([]);
    expect(extractCardIdsFromTitle('Sammlung 228 Karten')).toEqual([]);
  });

  test('prices, counts and sizes after a prefix are not ids', () => {
    expect(extractCardIdsFromTitle('Karte 1,50 €')).toEqual(['1']);
    expect(extractCardIdsFromTitle('Nr. 12, 3er Set')).toEqual(['12']);
    expect(extractCardIdsFromTitle('Karte 12 und 3 weitere')).toEqual(['12']);
    expect(extractCardIdsFromTitle('Karte 3er Set')).toEqual([]);
    expect(extractCardIdsFromTitle('Nr. 1er')).toEqual([]);
    expect(extractCardIdsFromTitle('11/2026 neu')).toEqual([]);
    expect(extractCardIdsFromTitle('Größe 10/12')).toEqual([]);
  });

  test('dedupes and sorts', () => {
    expect(extractCardIdsFromTitle('LE8 #45 #12 Nr. 12')).toEqual(['12', '45', 'LE8']);
  });
});

function makeFetch(
  options: {
    tokenStatus?: number;
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
      return new Response(readFixture('ebay-token.json'), { status: options.tokenStatus ?? 200 });
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
    const listings = await adapter.fetchListings();
    expect(listings).toHaveLength(4);
    expect(adapter.lastSkippedNoId).toBe(1);
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
    expect(listings.find((l) => l.cardIds.includes('LE8'))).toMatchObject({
      format: 'fixed_price',
      cardIds: ['12', '45', 'LE8'],
      price: { cents: 599, currency: 'EUR' },
      auctionEndsAt: null,
      imageUrl: 'https://i.ebayimg.com/images/g/bbb/s-l225.jpg',
    });
    const noImage = listings.find((l) => l.url.endsWith('110000000005'))!;
    expect(noImage.imageUrl).toBeNull();
    expect(noImage.price).toEqual({ cents: 200, currency: 'EUR' });
    expect(noImage.cardIds).toEqual(['107']);
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
    const first = await adapter.fetchListings();
    const second = await adapter.fetchListings();
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
    expect((await adapter.fetchListings()).map((l) => l.url)).toEqual([
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
    expect(await adapter.fetchListings()).toEqual([]);
    expect(adapter.lastSkippedNoId).toBe(1);
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
