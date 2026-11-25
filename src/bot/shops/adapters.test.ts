import { describe, expect, spyOn, test } from 'bun:test';
import * as cheerio from 'cheerio';
import logger from '../utils/logger';
import { readFixture } from '../../test/shopHelpers';
import { cid } from '../../test/cardIds';
import { checkAdapters, createShopAdapters, enabledShopsOf } from './adapters';
import { legoMinecraft1 } from '../collections/legoMinecraft1';
import { turboAttax2026 } from '../collections/turboAttax2026';
import { MINECRAFT_CARD_IDS, TURBO_ATTAX_CARD_IDS } from '../cards/cardId';
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
      'collect-it:lego-minecraft-3',
      'collect-it:turbo-attax-2026',
      'euro-soccer-cards:turbo-attax-2026',
      'blue-ocean:lego-minecraft-3',
    ]);
    expect(warned.some((w) => w.includes('eBay disabled'))).toBe(true);
  });

  test("Turbo Attax's collect-it adapter reads titles with Turbo Attax's id rule", async () => {
    const $ = cheerio.load(readFixture('collect-it-turbo-attax-p10.html'));
    const category =
      'https://www.collect-it.de/sammelkarten/formel1/Topps-Turbo-Attax-Formel-1-2026/Einzelkarten';
    $('link[rel="next"], link[rel="prev"]').remove();
    $('link[rel="canonical"]').attr('href', category);
    $('.ci-pagination-meta').html('Du hast <strong>alle 30</strong> Artikel gesehen');
    const adapters = withWarnings(() =>
      createShopAdapters(null, undefined, {
        fetchFn: async () => new Response($.html()),
        sleep: async () => {},
      })
    ).value;
    const ta = adapters.find((a) => a.id === 'collect-it' && a.collection === 'turbo-attax-2026')!;
    const { listings } = await ta.fetchListings();
    expect(listings.map((l) => l.cardIds[0])).toContain(cid('MR-HAM'));
  });

  test('with eBay credentials, one eBay adapter covers every collection, and no warning', () => {
    const { value, warned } = withWarnings(() =>
      createShopAdapters({ clientId: 'id', clientSecret: 'secret' })
    );
    const ebay = value.filter((a) => a.id === 'ebay');
    expect(ebay).toHaveLength(1);
    // The run's skipped counts are filed under series 3, the summary's `shops`.
    expect(ebay[0]!.collection).toBe('lego-minecraft-3');
    expect(ebay[0]!.collections).toEqual([
      'lego-minecraft-1',
      'lego-minecraft-2',
      'lego-minecraft-3',
      'turbo-attax-2026',
    ]);
    expect(enabledShopsOf(value).get('turbo-attax-2026')).toEqual([
      'collect-it',
      'euro-soccer-cards',
      'ebay',
    ]);
    expect(enabledShopsOf(value).get('lego-minecraft-2')).toEqual([
      'sammel-ente',
      'blue-ocean',
      'ebay',
    ]);
    expect(warned.some((w) => w.includes('eBay disabled'))).toBe(false);
  });

  test('one blue-ocean adapter covers every collection; without series 3 the first one files the counts', () => {
    const value = withWarnings(() => createShopAdapters(null)).value;
    const blue = value.filter((a) => a.id === 'blue-ocean');
    expect(blue).toHaveLength(1);
    expect(blue[0]!.collection).toBe('lego-minecraft-3');
    expect(blue[0]!.collections).toEqual([
      'lego-minecraft-1',
      'lego-minecraft-2',
      'lego-minecraft-3',
    ]);
    const [only] = createShopAdapters(null, undefined, {
      collections: [
        { ...legoMinecraft1, shops: { 'blue-ocean': legoMinecraft1.shops['blue-ocean']! } },
      ],
    });
    expect(only).toMatchObject({ id: 'blue-ocean', collection: 'lego-minecraft-1' });
    expect(only!.collections).toEqual(['lego-minecraft-1']);
  });

  test('two collections sharing a blue-ocean product code, category path or picture part are refused', () => {
    const one = legoMinecraft1.shops['blue-ocean']!;
    const other = { ...legoMinecraft1, id: 'lego-minecraft-2' as const };
    for (const [field, shared] of [
      ['productCode', { productCode: one.productCode }],
      ['categoryPath', { productCode: 'x1', categoryPath: one.categoryPath }],
      ['picture', { productCode: 'x1', picture: one.picture }],
    ] as const) {
      const collections = [legoMinecraft1, { ...other, shops: { 'blue-ocean': shared } }];
      expect(() => createShopAdapters(null, undefined, { collections })).toThrow(
        `lego-minecraft-2: blue-ocean ${field} "${String(shared[field as keyof typeof shared])}" overlaps lego-minecraft-1's`
      );
    }
  });

  test("a picture part containing another collection's, in any case, is refused", () => {
    const other = { ...legoMinecraft1, id: 'lego-minecraft-2' as const };
    for (const picture of ['_TCC-01', '_tcc-0', '_tcc-01_de']) {
      const collections = [
        legoMinecraft1,
        { ...other, shops: { 'blue-ocean': { productCode: 'x1', picture } } },
      ];
      expect(() => createShopAdapters(null, undefined, { collections })).toThrow(
        `lego-minecraft-2: blue-ocean picture "${picture}" overlaps lego-minecraft-1's "_tcc-01"`
      );
    }
  });

  test('without a collection on blue-ocean there is no blue-ocean adapter', () => {
    const off = { ...legoMinecraft1, shops: {} };
    expect(createShopAdapters(null, undefined, { collections: [off] })).toEqual([]);
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
    const noSearch = {
      ...legoMinecraft1,
      shops: { ebay: { queries: [], idForms: 'minecraft' as const, series: /Serie 1/i } },
    };
    expect(() => createShopAdapters(creds, undefined, { collections: [noSearch] })).toThrow(
      'lego-minecraft-1: eBay settings without a search'
    );
    const global = {
      ...legoMinecraft1,
      shops: { ebay: { queries: ['q'], idForms: 'minecraft' as const, series: /Serie 1/gi } },
    };
    expect(() => createShopAdapters(creds, undefined, { collections: [global] })).toThrow(
      'must not use the g or y flag'
    );
    const sticky = {
      ...legoMinecraft1,
      shops: { ebay: { queries: ['q'], idForms: 'minecraft' as const, series: /Serie 1/y } },
    };
    expect(() => createShopAdapters(creds, undefined, { collections: [sticky] })).toThrow(
      'must not use the g or y flag'
    );
  });

  test('an eBay exclusion pattern with g or y, or a page cap outside 1-50, is refused at start', () => {
    const creds = { clientId: 'id', clientSecret: 's' };
    const ebay = (over: object) => ({
      ...legoMinecraft1,
      shops: { ebay: { ...legoMinecraft1.shops.ebay!, ...over } },
    });
    expect(() =>
      createShopAdapters(creds, undefined, { collections: [ebay({ excludes: /pink/gi })] })
    ).toThrow('lego-minecraft-1: the eBay exclusion pattern must not use the g or y flag');
    for (const maxPages of [0, 51, 2.5]) {
      expect(() =>
        createShopAdapters(creds, undefined, { collections: [ebay({ maxPages })] })
      ).toThrow('lego-minecraft-1: the eBay page cap must be a whole number from 1 to 50');
    }
  });

  test('a series label of no readable kind is refused at start', () => {
    const at = (shop: 'sammel-ente' | 'collect-it', series: string) => () =>
      createShopAdapters(null, undefined, {
        collections: [
          { ...legoMinecraft1, shops: { [shop]: { ...legoMinecraft1.shops[shop]!, series } } },
        ],
      });
    expect(at('collect-it', 'Series 1')).toThrow(
      'lego-minecraft-1: the collect-it series label must be "Serie N" or a year'
    );
    expect(at('collect-it', '2026')).not.toThrow();
    expect(at('sammel-ente', '2026')).toThrow(
      'lego-minecraft-1: the sammel-ente series label must be "Serie N"'
    );
  });

  test('a euro-soccer-cards slug suffix of no lowercase slug form is refused at start', () => {
    for (const slugSuffix of ['-Turbo-Attax-2026', 'turbo-attax-2026', '-a/b']) {
      const bad = {
        ...turboAttax2026,
        shops: {
          'euro-soccer-cards': { ...turboAttax2026.shops['euro-soccer-cards']!, slugSuffix },
        },
      };
      expect(() => createShopAdapters(null, undefined, { collections: [bad] })).toThrow(
        'turbo-attax-2026: the euro-soccer-cards slug suffix must be empty or a dash-led lowercase slug'
      );
    }
  });

  test('a euro-soccer-cards category without its trailing slash is refused at start', () => {
    const bad = {
      ...turboAttax2026,
      shops: {
        'euro-soccer-cards': {
          category: 'https://www.euro-soccer-cards.com/gb/topps-turbo-attax-2026',
          slugSuffix: '',
        },
      },
    };
    expect(() => createShopAdapters(null, undefined, { collections: [bad] })).toThrow(
      'turbo-attax-2026: the euro-soccer-cards category must end with /'
    );
  });

  test('a euro-soccer-cards category on another host is refused at start', () => {
    const elsewhere = {
      ...turboAttax2026,
      shops: {
        'euro-soccer-cards': {
          category: 'https://euro-soccer-cards.example/gb/topps-turbo-attax-2026/',
          slugSuffix: '',
        },
      },
    };
    expect(() => createShopAdapters(null, undefined, { collections: [elsewhere] })).toThrow(
      'turbo-attax-2026: euro-soccer-cards category is on euro-soccer-cards.example, not www.euro-soccer-cards.com'
    );
  });

  test('a malformed card id rule or Kleinanzeigen words are refused at start', () => {
    const at = (over: object) => () =>
      createShopAdapters(null, undefined, { collections: [{ ...legoMinecraft1, ...over }] });
    for (const cardIds of [
      { prefixes: ['le'] },
      { prefixes: ['LE', 'LE'] },
      { prefixes: ['L1'] },
      { prefixes: [] as string[], codes: ['MRX'] },
      { prefixes: [] as string[], codes: ['MR', 'MR'] },
    ]) {
      expect(at({ cardIds })).toThrow('lego-minecraft-1: the card id rule');
    }
    for (const kleinanzeigen of ['', 'lego minecraft', 'lego/minecraft', 'Lego', '-x']) {
      expect(at({ kleinanzeigen })).toThrow('lego-minecraft-1: the Kleinanzeigen search words');
    }
  });

  test("a shop's title forms must fit the collection's id rule", () => {
    const creds = { clientId: 'id', clientSecret: 's' };
    const mixed = {
      ...turboAttax2026,
      shops: { ebay: { ...turboAttax2026.shops.ebay!, idForms: 'minecraft' as const } },
    };
    expect(() => createShopAdapters(creds, undefined, { collections: [mixed] })).toThrow(
      "turbo-attax-2026: eBay's minecraft title forms read another id rule than the collection's"
    );
    const taForms = {
      ...legoMinecraft1,
      shops: { ebay: { ...legoMinecraft1.shops.ebay!, idForms: 'turbo-attax' as const } },
    };
    expect(() => createShopAdapters(creds, undefined, { collections: [taForms] })).toThrow(
      "lego-minecraft-1: eBay's turbo-attax title forms read another id rule"
    );
    // sammel-ente and blue-ocean read Minecraft ids only.
    for (const shop of ['sammel-ente', 'blue-ocean'] as const) {
      const wrong = {
        ...legoMinecraft1,
        cardIds: TURBO_ATTAX_CARD_IDS,
        shops: { [shop]: legoMinecraft1.shops[shop]! },
      };
      expect(() => createShopAdapters(null, undefined, { collections: [wrong] })).toThrow(
        `lego-minecraft-1: ${shop} reads only LEGO Minecraft card ids`
      );
    }
    expect(() =>
      createShopAdapters(null, undefined, {
        collections: [{ ...legoMinecraft1, cardIds: { ...MINECRAFT_CARD_IDS } }],
      })
    ).not.toThrow();
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

  test('invalid blue-ocean settings are refused at start', () => {
    const noCode = { ...legoMinecraft1, shops: { 'blue-ocean': { productCode: '' } } };
    expect(() => createShopAdapters(null, undefined, { collections: [noCode] })).toThrow(
      'lego-minecraft-1: blue-ocean settings without a product code'
    );
    for (const productCode of ['70.351', '70+351', '2DD00088']) {
      const bad = { ...legoMinecraft1, shops: { 'blue-ocean': { productCode } } };
      expect(() => createShopAdapters(null, undefined, { collections: [bad] })).toThrow(
        'lego-minecraft-1: the blue-ocean product code must be lowercase letters and digits'
      );
    }
    for (const empty of [{ picture: '' }, { categoryPath: '' }, { categoryPath: 'lego/serie-1' }]) {
      const bad = {
        ...legoMinecraft1,
        shops: { 'blue-ocean': { productCode: '702351', ...empty } },
      };
      expect(() => createShopAdapters(null, undefined, { collections: [bad] })).toThrow(
        'lego-minecraft-1: blue-ocean settings with an empty picture or an empty or multi-segment category path'
      );
    }
    for (const excludes of [/TCC 2/g, /TCC 2/y]) {
      const bad = {
        ...legoMinecraft1,
        shops: { 'blue-ocean': { productCode: '702351', excludes } },
      };
      expect(() => createShopAdapters(null, undefined, { collections: [bad] })).toThrow(
        'the blue-ocean title or exclusion marker must not use the g or y flag'
      );
    }
    for (const title of [/TCC 1/g, /TCC 1/y]) {
      const bad = { ...legoMinecraft1, shops: { 'blue-ocean': { productCode: '702351', title } } };
      expect(() => createShopAdapters(null, undefined, { collections: [bad] })).toThrow(
        'lego-minecraft-1: the blue-ocean title or exclusion marker must not use the g or y flag'
      );
    }
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
    expect(enabled.get('lego-minecraft-1')).toEqual(['sammel-ente', 'collect-it', 'blue-ocean']);
    expect(enabled.get('lego-minecraft-2')).toEqual(['sammel-ente', 'blue-ocean']);
    expect(enabled.get('lego-minecraft-3')).toEqual(['sammel-ente', 'collect-it', 'blue-ocean']);
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
