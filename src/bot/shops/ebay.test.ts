import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
import { createEbayAdapter, extractCardIdsFromTitle, EBAY_QUERIES } from './ebay';
import { HttpError } from '../utils/http';
import { readFixture } from '../../test/shopHelpers';
import { ShopLayoutError, type FetchFn } from './types';
import { cid, ids } from '../../test/cardIds';

/** A title marked as series 3, so only the id patterns are under test. */
const s3 = (title: string) => extractCardIdsFromTitle(`On Fire ${title}`);

interface FixtureItem {
  itemId: string;
  legacyItemId?: string;
  title: string;
}
const fixtureItems = (
  JSON.parse(readFixture('ebay-search.json')) as { itemSummaries: FixtureItem[] }
).itemSummaries;

/**
 * Reviewed ids of every item in the fixture (real titles from 2026-11-18, plus five made-up
 * ones with 1100000000xx ids). Every item must be listed, so a new fixture item gets reviewed.
 */
const FIXTURE_IDS: Record<string, string[]> = {
  // Made up.
  '110000000001': ['12'],
  '110000000002': ['12', '45', 'LE8'],
  '110000000003': ['107'],
  '110000000004': [],
  '110000000005': ['107'],
  // "Karten N - Name - Type ... Serie 3".
  '307033154225': ['1'],
  '298464547193': ['6'],
  '820220708310': ['12'],
  '307033238089': ['13'],
  '307033164852': ['81'],
  '306904746510': ['154'],
  '298266919445': ['190'],
  '298464913981': ['210'],
  '307033129412': ['226'],
  // "Minecraft  N - Name - Charakterkarte ... Serie 3".
  '307033237331': ['59'],
  '298266882310': ['85'],
  // "NAME N Karte".
  '880079740087': ['68'],
  '880120413461': ['8'],
  // Limited cards.
  '880127012180': ['LE21'],
  '880113389508': ['LE22'],
  '318738930910': ['LE12'],
  '298542435874': ['LE1'],
  '307151001820': ['LE16'],
  // A blister sold with its named limited card.
  '318920506278': ['LE16'],
  // "Nr41".
  '336881714628': ['41'],
  // Packs, counts, a name without a number.
  '237167730326': [],
  '318113529715': [],
  '257656279927': [],
  '168243696252': [],
  '318793648300': [],
  '306898657124': [],
  '336881691966': [],
  // Multi-pick listings and ranges.
  '298476153721': [],
  '820220677540': [],
  '960043845055': [],
  '277849229105': [],
  '336833205199': [],
  // Series 1 and 2.
  '296375051309': [],
  '296375051455': [],
  '305536785803': [],
  '315605969936': [],
  '366399742152': [],
  // No series word.
  '294036373907': [],
};

const fixtureKey = (item: FixtureItem) =>
  item.legacyItemId ?? /^v1\|(\d+)\|/.exec(item.itemId)?.[1] ?? item.itemId;

describe('extractCardIdsFromTitle', () => {
  test('reads prefixed numbers', () => {
    expect(extractCardIdsFromTitle('LEGO Minecraft On Fire Karte Nr. 12 Squid')).toEqual([
      cid('12'),
    ]);
    expect(s3('Karte Nr.12')).toEqual([cid('12')]);
    expect(s3('Card No. 7')).toEqual([cid('7')]);
    expect(s3('Karte 012')).toEqual([cid('12')]);
    expect(s3('Card 5')).toEqual([cid('5')]);
  });

  test('reads bundles, LE and XXL ids', () => {
    expect(extractCardIdsFromTitle('Lego Minecraft TCC Serie 3 #12, #45 und LE8')).toEqual(
      ids('12', '45', 'LE8')
    );
    expect(s3('LE 08 und XXL1')).toEqual(ids('LE8', 'XXL1'));
    expect(s3('Nr. 12, 45 und 107')).toEqual(ids('12', '45', '107'));
  });

  test('takes the card number of a 12/228 title and ignores bare numbers', () => {
    expect(extractCardIdsFromTitle('Minecraft Serie 3 Karte 107/228 2026')).toEqual([cid('107')]);
    expect(s3('Squid 12/228')).toEqual([cid('12')]);
    expect(extractCardIdsFromTitle('LEGO Minecraft Serie 3 Booster 2026')).toEqual([]);
    expect(s3('Sammlung 228 Karten')).toEqual([]);
  });

  test('prices, counts and sizes after a prefix are not ids', () => {
    expect(s3('Karte 1,50 €')).toEqual([cid('1')]);
    expect(s3('Nr. 12, 3er Set')).toEqual([cid('12')]);
    expect(s3('Karte 12 und 3 weitere')).toEqual([cid('12')]);
    expect(s3('Karte 3er Set')).toEqual([]);
    expect(s3('Nr. 1er')).toEqual([]);
    expect(s3('11/2026 neu')).toEqual([]);
    expect(s3('Größe 10/12')).toEqual([]);
  });

  test('dedupes and sorts', () => {
    expect(s3('LE8 #45 #12 Nr. 12')).toEqual(ids('12', '45', 'LE8'));
  });

  test('reads "Karten N - Name" and "N - Name - Typkarte"', () => {
    expect(
      extractCardIdsFromTitle('LEGO Minecraft Karten 30 - Steve - Charakterkarte Serie 3 (2026)')
    ).toEqual([cid('30')]);
    expect(
      extractCardIdsFromTitle(
        'LEGO Minecraft Karten 226 - Vernetzungstreffen - Comickarte Serie 3 (2026)'
      )
    ).toEqual([cid('226')]);
    expect(s3('Karten 7 – Shadow Hoodie')).toEqual([cid('7')]);
    expect(
      extractCardIdsFromTitle(
        'LEGO Minecraft  132 - Wither Skeleton - Charakterkarte - Holo Serie 3 (2026)'
      )
    ).toEqual([cid('132')]);
    expect(s3('Karten 12')).toEqual([]);
    expect(s3('111 Karten - neuwertig')).toEqual([]);
  });

  test('reads a number directly before Karte or Card, but not counts', () => {
    expect(
      extractCardIdsFromTitle(
        'LEGO MINECRAFT ON FIRE Serie 3 ULTRA RARE ZOMBIE 68 Karte Trading Card'
      )
    ).toEqual([cid('68')]);
    expect(s3('Villager 8 Card')).toEqual([cid('8')]);
    expect(s3('Blue Ocean Trading Cards 21 Packs à 6 Karten Creeper')).toEqual([]);
    expect(s3('193 verschiedene Karten')).toEqual([]);
    expect(s3('6 Karten')).toEqual([]);
    expect(s3('6 Cards')).toEqual([]);
    expect(s3('incl. 1 special Card')).toEqual([]);
    expect(s3('inkl 1 Karte')).toEqual([]);
    expect(s3('plus 2 Karte')).toEqual([]);
    // The series number is not a card number.
    expect(extractCardIdsFromTitle('LEGO Minecraft Serie 3 Karte #107 Auktion')).toEqual([
      cid('107'),
    ]);
    expect(extractCardIdsFromTitle('LEGO Minecraft Series 3 Card')).toEqual([]);
  });

  test('only titles that name series 3 give ids', () => {
    expect(extractCardIdsFromTitle('LEGO Minecraft Serie 3 Karte #12')).toEqual([cid('12')]);
    expect(extractCardIdsFromTitle('LEGO Minecraft Series 3 Karte #12')).toEqual([cid('12')]);
    expect(extractCardIdsFromTitle('LEGO Minecraft Serie3 Karte #12')).toEqual([cid('12')]);
    expect(extractCardIdsFromTitle('LEGO Minecraft ON FIRE Karte #12')).toEqual([cid('12')]);
    // Series 1 and 2 used the same title forms: without a series word, no ids.
    expect(extractCardIdsFromTitle('LEGO Minecraft Karten 30 - Steve - Charakterkarte')).toEqual(
      []
    );
    expect(extractCardIdsFromTitle('LEGO Minecraft Karte #12 LE8')).toEqual([]);
    expect(extractCardIdsFromTitle('Minecraft Trading Cards 2021 - Nr. 215 Foil Karte')).toEqual(
      []
    );
  });

  test('titles naming series 1 or 2 give no ids, even with series 3 in them', () => {
    expect(
      extractCardIdsFromTitle('LEGO Minecraft Serie 1 Trading Card 3 - Comic Steve - Skin Karte')
    ).toEqual([]);
    expect(extractCardIdsFromTitle('Lego Minecraft Sammelkarten Serie 2 LE8')).toEqual([]);
    expect(extractCardIdsFromTitle('Lego Minecraft Serie 2 und Serie 3 Karte #12, #45')).toEqual(
      []
    );
    expect(extractCardIdsFromTitle('LEGO Minecraft On Fire Series 1 Card 5')).toEqual([]);
    // "Serie 12" is not series 1.
    expect(extractCardIdsFromTitle('On Fire Karte #12 Serie 12')).toEqual([cid('12')]);
  });

  test('multi-pick listings and ranges give no ids', () => {
    expect(
      extractCardIdsFromTitle(
        'LEGO Minecraft Serie 3 Trading Cards Einzelkarten 1 - 228 zum aussuchen choose'
      )
    ).toEqual([]);
    expect(s3('Karte #12 zum Aussuchen')).toEqual([]);
    expect(s3('Karte #12 auswählen')).toEqual([]);
    expect(s3('Karte #12 Auswahl')).toEqual([]);
    expect(s3('Karte #12 du wählst')).toEqual([]);
    expect(s3('Karte #12 choose')).toEqual([]);
    expect(s3('Karte #12 pick')).toEqual([]);
    expect(s3('Karte #12 151-254')).toEqual([]);
    expect(s3('LE1 - LE22')).toEqual([]);
    expect(s3('Karte #12, Karten 1 bis 228')).toEqual([]);
  });

  test('every fixture title gives its reviewed ids', () => {
    const seen = new Set<string>();
    for (const item of fixtureItems) {
      const key = fixtureKey(item);
      seen.add(key);
      expect({ key, title: item.title, ids: extractCardIdsFromTitle(item.title) }).toEqual({
        key,
        title: item.title,
        ids: FIXTURE_IDS[key] as never,
      });
    }
    expect([...seen].sort()).toEqual(Object.keys(FIXTURE_IDS).sort());
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

const noSleep = async () => {};

describe('createEbayAdapter', () => {
  test('maps listings, skips items without ids and caches the token', async () => {
    const fake = makeFetch();
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 'secret',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const { listings, skippedNoId, skippedInvalid } = await adapter.fetchListings();
    // 4 made-up and 20 real items with ids; 1 made-up and 18 real without.
    expect(listings).toHaveLength(24);
    expect(skippedNoId).toBe(19);
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

    // Real items.
    expect(listings.find((l) => l.url.endsWith('307033129412'))).toMatchObject({
      title: 'LEGO Minecraft Karten 226 - Vernetzungstreffen - Comickarte Serie 3 (2026)',
      cardIds: ['226'],
      price: { cents: 100 + 130, currency: 'EUR' },
      format: 'fixed_price',
    });
    expect(listings.some((l) => l.url.endsWith('298476153721'))).toBe(false);
  });

  test('searches every query, the broad series 3 query included', () => {
    expect(EBAY_QUERIES).toContain('lego minecraft karten serie 3');
  });

  test('a listing with seller-defined variations gives no ids', async () => {
    const fake = makeFetch({
      searchBody: () =>
        body(
          item({
            title: 'LEGO Minecraft Serie 3 Karte Nr. 12',
            itemGroupType: 'SELLER_DEFINED_VARIATIONS',
          })
        ),
    });
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    expect(await adapter.fetchListings()).toMatchObject({ listings: [], skippedNoId: 1 });
  });

  describe('paging', () => {
    /** A search answer for the requested offset: `total` results, `perPage` per page. */
    const paged =
      (total: number, perPage = 200) =>
      (url: string) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
        const count = Math.max(0, Math.min(perPage, total - offset));
        const items = Array.from({ length: count }, (_, i) => {
          const n = String(500000000000 + offset + i);
          return item({
            itemId: `v1|${n}|0`,
            legacyItemId: n,
            itemWebUrl: `https://www.ebay.de/itm/${n}`,
          });
        });
        return JSON.stringify({ total, offset, limit: 200, itemSummaries: items });
      };

    const run = async (answer: (url: string) => string) => {
      const urls: string[] = [];
      const sleeps: number[] = [];
      const fetchFn: FetchFn = async (url) => {
        if (url.includes('/oauth2/token')) return new Response(readFixture('ebay-token.json'));
        urls.push(url);
        return new Response(answer(url));
      };
      const adapter = createEbayAdapter({
        clientId: 'id',
        clientSecret: 's',
        fetchFn,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      const result = await adapter.fetchListings();
      return { result, urls, sleeps };
    };
    const offsets = (urls: string[]) =>
      urls.map(
        (u) => `${new URL(u).searchParams.get('q')}@${new URL(u).searchParams.get('offset')}`
      );

    test('reads every page by offset and stops at the total', async () => {
      const { result, urls } = await run(paged(450));
      expect(offsets(urls).slice(0, 3)).toEqual(
        [0, 200, 400].map((o) => `${EBAY_QUERIES[0]}@${o}`)
      );
      expect(urls).toHaveLength(3 * EBAY_QUERIES.length);
      for (const u of urls) expect(u).toContain('limit=200');
      // Every query answers the same 450 items.
      expect(result.listings).toHaveLength(450);
    });

    test('one page when the total fits', async () => {
      const { urls } = await run(paged(200));
      expect(urls).toHaveLength(EBAY_QUERIES.length);
    });

    test('an empty page ends the walk even when the total says more', async () => {
      const { urls } = await run((url) =>
        new URL(url).searchParams.get('offset') === '0'
          ? paged(450)(url)
          : JSON.stringify({ total: 450, itemSummaries: [] })
      );
      expect(urls).toHaveLength(2 * EBAY_QUERIES.length);
    });

    test('stops at the page cap and warns', async () => {
      const warn = spyOn(logger, 'warn');
      try {
        const { urls } = await run(paged(5000));
        expect(urls).toHaveLength(5 * EBAY_QUERIES.length);
        expect(offsets(urls).slice(0, 5)).toEqual(
          [0, 200, 400, 600, 800].map((o) => `${EBAY_QUERIES[0]}@${o}`)
        );
        expect(
          warn.mock.calls.some((c) =>
            String(c[0]).includes('5000 results, only the first 1000 read')
          )
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    test('waits 1500 ms between two search requests', async () => {
      const { urls, sleeps } = await run(paged(450));
      expect(sleeps).toHaveLength(urls.length - 1);
      expect(new Set(sleeps)).toEqual(new Set([1500]));
    });

    test('a failing later page is a shop error', async () => {
      const fetchFn: FetchFn = async (url) => {
        if (url.includes('/oauth2/token')) return new Response(readFixture('ebay-token.json'));
        if (new URL(url).searchParams.get('offset') === '200')
          return new Response('', { status: 500 });
        return new Response(paged(450)(url));
      };
      const adapter = createEbayAdapter({
        clientId: 'id',
        clientSecret: 's',
        fetchFn,
        sleep: noSleep,
      });
      await expect(adapter.fetchListings()).rejects.toBeInstanceOf(HttpError);
    });
  });

  const item = (over: Record<string, unknown>) => ({
    itemId: 'v1|220000000001|0',
    legacyItemId: '220000000001',
    title: 'LEGO Minecraft Serie 3 Karte Nr. 12',
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
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
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
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    expect((await adapter.fetchListings()).listings.map((l) => l.url)).toEqual([
      'https://www.ebay.de/itm/330000000001',
    ]);
  });

  test('every search returning zero items is a layout error', async () => {
    const fake = makeFetch({ searchBody: () => JSON.stringify({ total: 0 }) });
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    await expect(adapter.fetchListings()).rejects.toBeInstanceOf(ShopLayoutError);
  });

  test('one search with items is enough, even when none of them names a card', async () => {
    const fake = makeFetch({
      searchBody: (n) => (n === 1 ? body(item({ title: 'LEGO Minecraft Booster' })) : body()),
    });
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
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
      sleep: noSleep,
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
      sleep: noSleep,
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
      sleep: noSleep,
    });
    const error = (await adapter.fetchListings().catch((e: unknown) => e)) as HttpError;
    expect(error.message).toContain('invalid_client');
    expect(error.message).toContain('[redacted]');
    expect(error.message).not.toContain('topsecret');
    expect(error.message).not.toContain('leaked');
  });

  test('a failure answer without eBay error fields gives its message, else its field names only', async () => {
    const failWith = async (body: object) => {
      const fake = makeFetch({
        tokenStatus: 503,
        tokenBody: JSON.stringify({ ...body, access_token: 'v^1.1#leaked' }),
      });
      const adapter = createEbayAdapter({
        clientId: 'id',
        clientSecret: 'topsecret',
        fetchFn: fake.fetchFn,
        sleep: noSleep,
      });
      return (await adapter.fetchListings().catch((e: unknown) => e)) as HttpError;
    };
    const withMessage = await failWith({ message: 'Service unavailable' });
    expect(withMessage.message).toContain('Service unavailable');
    expect(withMessage.message).not.toContain('leaked');
    const withFields = await failWith({ status: 'down' });
    expect(withFields.message).toContain('fields: status, access_token');
    expect(withFields.message).not.toContain('leaked');
    expect(withFields.message).not.toContain('down');
  });

  test('failure bodies that are not JSON objects, or have odd fields, are not echoed', async () => {
    const failRaw = async (tokenBody: string) => {
      const fake = makeFetch({ tokenStatus: 503, tokenBody });
      const adapter = createEbayAdapter({
        clientId: 'id',
        clientSecret: 'topsecret',
        fetchFn: fake.fetchFn,
        sleep: noSleep,
      });
      return (await adapter.fetchListings().catch((e: unknown) => e)) as HttpError;
    };
    const asString = await failRaw(JSON.stringify('v^1.1#leaked'));
    expect(asString.message).toContain('JSON but not an object');
    expect(asString.message).not.toContain('leaked');
    const asArray = await failRaw(JSON.stringify(['v^1.1#leaked']));
    expect(asArray.message).toContain('answer is a JSON array');
    expect(asArray.message).not.toContain('leaked');
    const withTitle = await failRaw(JSON.stringify({ title: 'Bad Gateway' }));
    expect(withTitle.message).toContain('Bad Gateway');
    const errorsString = await failRaw(
      JSON.stringify({ errors: 'x', access_token: 'v^1.1#leaked' })
    );
    expect(errorsString.message).toContain('fields: errors, access_token');
    expect(errorsString.message).not.toContain('leaked');
    const oddLong = await failRaw(
      JSON.stringify({ errors: [{ longMessage: 5, message: 'Use the message' }] })
    );
    expect(oddLong.message).toContain('Use the message');
  });

  test("a search failure keeps at most 300 characters of eBay's error message", async () => {
    const fake = makeFetch({
      searchStatus: 400,
      searchBody: () =>
        JSON.stringify({ errors: [{ longMessage: `bad query ${'x'.repeat(500)}` }] }),
    });
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const error = (await adapter.fetchListings().catch((e: unknown) => e)) as HttpError;
    expect(error).toBeInstanceOf(HttpError);
    expect(error.message).toContain('bad query');
    expect(error.message).toContain(fake.searchUrls[0]!);
    expect(error.message.length).toBeLessThan(fake.searchUrls[0]!.length + 340);
  });

  test('an answer that is not JSON names the URL', async () => {
    const fake = makeFetch({ searchBody: () => '<html>maintenance</html>' });
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const error = (await adapter.fetchListings().catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('not JSON');
    expect(error.message).toContain('item_summary/search');
  });

  test('a search answer with errors and no items throws', async () => {
    const fake = makeFetch({
      searchBody: () => JSON.stringify({ errors: [{ message: 'Invalid category' }] }),
    });
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
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
        sleep: noSleep,
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
    const adapter = createEbayAdapter({
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
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
        sleep: noSleep,
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
        sleep: noSleep,
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
      sleep: noSleep,
    });
    await expect(adapter.fetchListings()).rejects.toBeInstanceOf(HttpError);
  });
});
