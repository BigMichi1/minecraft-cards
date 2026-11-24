import { describe, expect, spyOn, test } from 'bun:test';
import * as cheerio from 'cheerio';
import {
  blueOceanCollectionsOf,
  BLUE_OCEAN_COLLECTIONS,
  createBlueOceanFetcher,
  parseBlueOceanPage,
} from './blueOcean';
import { COLLECTIONS } from '../collections/index';
import { ShopLayoutError, type Listing } from './types';
import logger from '../utils/logger';
import { readFixture, fakeFetch } from '../../test/shopHelpers';
import { cid, ids } from '../../test/cardIds';

function box(href: string, title: string, image: string, stock = 'Auf Lager'): string {
  return `<div class="product-card product-box"><img data-testid="product-box-img" src="${image}">
    <a data-testid="product-box-product-name-link" href="${href}"><div>${title}</div></a>
    <div data-testid="product-box-product-price"><p aria-label="Preis: 0.8"><span>0.8</span></p></div>
    <span>${stock}</span></div>`;
}

describe('parseBlueOceanPage', () => {
  const b1 = parseBlueOceanPage(readFixture('blue-ocean-p1.html'));

  test('uses the href number as card id, not the title number', () => {
    const squid = b1.listings.find((l) => l.url.endsWith('-2dd00088-12'))!;
    expect(squid.cardIds).toEqual([cid('12')]); // title says "Nr. 9"
    expect(squid).toMatchObject({
      shop: 'blue-ocean',
      collection: 'lego-minecraft-3',
      cardName: null,
      format: 'shop',
      available: true,
      idConflict: false,
      auctionEndsAt: null,
      price: { cents: 80, currency: 'EUR' },
    });
    expect(squid.url).toBe(
      'https://www.blue-ocean.de/nr.-9-squid-uncommonlego-minecraft-tcc-on-fire-2dd00088-12'
    );
    expect(squid.imageUrl).toContain('P12.jpg');
    expect(b1.listings.find((l) => l.url.endsWith('-107'))!.cardIds).toEqual([cid('107')]);
  });

  test('keeps only TCC cards and counts only the listing grid as products', () => {
    expect(b1.listings.every((l) => l.title.includes('LEGO Minecraft TCC'))).toBe(true);
    expect(b1.listings.every((l) => l.title.includes('On Fire'))).toBe(true);
    expect(b1.listings).toHaveLength(19);
    expect(b1.listings.every((l) => l.collection === 'lego-minecraft-3')).toBe(true);
    // recommendation slider boxes are not part of the listing
    expect(b1.productCount).toBe(24);
  });

  test('skips series 2 TCC products but still counts them as products', () => {
    // No saved fixture holds a non-"On Fire" TCC product, so rewrite a real product box.
    const $ = cheerio.load(readFixture('blue-ocean-p1.html'));
    const link = $('a[data-testid="product-box-product-name-link"]').first();
    link.attr('href', '/nr.-5-creeper-commonlego-minecraft-tcc-serie-2-2dd00088-5');
    link.find('div').first().text('Nr. 5 Creeper| CommonLEGO Minecraft TCC Serie 2');
    const boxHtml = $.html(link.closest('[data-testid="product-box"], .product-card'));
    const parsed = parseBlueOceanPage(`<div class="cms-page">${boxHtml}</div>`);
    expect(parsed.productCount).toBe(1);
    expect(parsed.listings).toEqual([]);
    expect(parsed.skippedExcluded).toBe(1);
    expect([...parsed.unreadable]).toEqual(['lego-minecraft-3']);
  });

  test('page 99 has no products', () => {
    expect(parseBlueOceanPage(readFixture('blue-ocean-p99.html'))).toEqual({
      listings: [],
      productCount: 0,
      isCategoryPage: true,
      skippedNoId: 0,
      skippedExcluded: 0,
      skippedInvalid: 0,
      unreadable: new Set(),
      unreadableUrls: [],
      productUrls: [],
      total: 0,
    });
  });

  test('parses page 2', () => {
    const b2 = parseBlueOceanPage(readFixture('blue-ocean-p2.html'));
    expect(b2.productCount).toBeGreaterThan(0);
    expect(b2.listings.some((l) => l.cardIds[0] === '93')).toBe(true);
  });

  test('flags a disagreement between the url number and the image number', () => {
    const html = box(
      '/nr.-1-foo-lego-minecraft-tcc-on-fire-2dd00088-5',
      'Nr. 1 Foo LEGO Minecraft TCC "On Fire"',
      'https://x.test/a/TCG3_.P7.jpg?ts=1'
    );
    const [l] = parseBlueOceanPage(html).listings;
    expect(l?.cardIds).toEqual(ids('5'));
    expect(l?.idConflict).toBe(true);
  });

  test('reads a sold out card as unavailable', () => {
    const html = box(
      '/nr.-1-foo-lego-minecraft-tcc-on-fire-2dd00088-5',
      'Nr. 1 Foo LEGO Minecraft TCC "On Fire"',
      'https://x.test/a/TCG3_.P5.jpg',
      'Nicht verfügbar'
    );
    expect(parseBlueOceanPage(html).listings[0]?.available).toBe(false);
  });

  test('a series 3 product without a card number in its URL is no card', () => {
    // The display is at "…-on-fire-display-2dd00088": the product code, but no number after it.
    const html = box(
      '/lego-minecraft-on-fire-display-2dd00088',
      'LEGO Minecraft TCC "On Fire" Display',
      ''
    );
    const parsed = parseBlueOceanPage(html);
    expect(parsed).toMatchObject({ listings: [], productCount: 1, skippedNoId: 0 });
  });
});

describe('parseBlueOceanPage across collections', () => {
  const S1 = '/lego/lego-minecraft/trading-card-collection-serie-1/18166';
  const S2 = '/lego/lego-minecraft/trading-card-collection-boom-bastic/22105';
  const row = (l: Listing) => [l.collection, l.cardIds, l.price?.cents, l.available];

  test('reads the collections from the registry, in its order', () => {
    expect(BLUE_OCEAN_COLLECTIONS).toEqual(blueOceanCollectionsOf(COLLECTIONS));
    expect(BLUE_OCEAN_COLLECTIONS.map((c) => c.id)).toEqual([
      'lego-minecraft-1',
      'lego-minecraft-2',
      'lego-minecraft-3',
    ]);
    expect(blueOceanCollectionsOf([{ ...COLLECTIONS[0]!, shops: {} }])).toEqual([]);
  });

  test('the series 1 and 2 page places every single in its collection', () => {
    const parsed = parseBlueOceanPage(readFixture('blue-ocean-tcc-p2.html'));
    const count = (c: string) => parsed.listings.filter((l) => l.collection === c).length;
    expect(count('lego-minecraft-1')).toBe(13);
    expect(count('lego-minecraft-2')).toBe(11);
    expect(parsed.listings).toHaveLength(24);
    expect(parsed).toMatchObject({ productCount: 24, skippedNoId: 0, skippedExcluded: 0 });
    const byTitle = (t: string) => parsed.listings.find((l) => l.title === t)!;
    expect(row(byTitle('Nummer 250 I Schildkröte I LEGO Minecraft TCC 1'))).toEqual([
      'lego-minecraft-1',
      ids('250'),
      80,
      true,
    ]);
    expect(row(byTitle('Nummer 249 I Roasted zombies'))).toEqual([
      'lego-minecraft-2',
      ids('249'),
      80,
      true,
    ]);
    const bat = byTitle('Nummer 248 I Fledermaus I LEGO Minecraft TCC 1');
    expect(row(bat)).toEqual(['lego-minecraft-1', ids('248'), 40, true]);
    expect(bat).toMatchObject({ shop: 'blue-ocean', format: 'shop', idConflict: false });
    expect(bat.url).toBe(
      'https://www.blue-ocean.de/lego/lego-minecraft/trading-card-collection-serie-1/18164/nummer-248-i-fledermaus-i-lego-minecraft-tcc-1'
    );
  });

  test('the root-level singles 1 to 9 are placed by their product code', () => {
    const parsed = parseBlueOceanPage(readFixture('blue-ocean-tcc-p31.html'));
    expect(parsed.listings.map((l) => [l.title, l.collection, l.cardIds])).toEqual([
      ['Nummer 002 I Comic Alex', 'lego-minecraft-2', ids('2')],
      ['Nummer 001 I Steve I LEGO Minecraft TCC 1', 'lego-minecraft-1', ids('1')],
      ['Nummer 001 I Alex', 'lego-minecraft-2', ids('1')],
    ]);
    // The sticker, the binder, the boosters and the displays are no cards, and not counted.
    expect(parsed).toMatchObject({ productCount: 14, skippedNoId: 0, skippedExcluded: 0 });
  });

  test('a sticker never becomes a card', () => {
    const html = [
      box(
        '/lego/lego-minecraft/stickerserie-1/21259/nummer-212-i-lego-minecraft-sticker',
        'Nummer 212 I LEGO® Minecraft Sticker',
        'https://x.test/212_lego_minecraft_sticker2025.jpg'
      ),
      box(
        '/nummer-009-i-lego-minecraft-sticker-00702506-09',
        'Nummer 009 I LEGO® Minecraft Sticker',
        'https://x.test/009_lego_minecraft_sticker2025.jpg'
      ),
    ].join('');
    expect(parseBlueOceanPage(html)).toMatchObject({
      listings: [],
      productCount: 2,
      skippedNoId: 0,
      skippedExcluded: 0,
    });
  });

  test('a title or picture naming another series excludes the product', () => {
    const cases = [
      box(
        `${S1}/nummer-012-i-steve-i-lego-minecraft-tcc-1`,
        'Nummer 012 I Steve I LEGO Minecraft TCC "On Fire"',
        'https://x.test/012_lego_minecraft_tcc-01_de.jpg'
      ),
      box(
        `${S2}/nummer-012-i-steve`,
        'Nummer 012 I Steve',
        'https://x.test/012_lego_minecraft_tcc-01_de.jpg'
      ),
      box(
        `${S1}/nummer-012-i-steve`,
        'Nummer 012 I Steve',
        'https://x.test/012_lego_minecraft_tcc-01_de.jpg'
      ),
      box(
        '/nummer-012-i-steve-i-lego-minecraft-tcc-1-702351-12',
        'Nummer 012 I Steve I LEGO Minecraft TCC 1',
        'https://x.test/012_lego_minecraft_tcc-02.jpg'
      ),
      box(`${S2}/nummer-012-i-steve`, 'Nummer 012 I Steve', 'https://x.test/a/LMC_TCG3_.P12.jpg'),
      box(
        `${S1}/nummer-012-i-steve-i-lego-minecraft-tcc-1`,
        'Nummer 012 I Steve I LEGO Minecraft TCC 1 Boom-Bastic',
        'https://x.test/012_lego_minecraft_tcc-01_de.jpg'
      ),
      box(
        `${S1}/nummer-012-i-steve-i-lego-minecraft-tcc-1`,
        'Nummer 012 I Steve I LEGO Minecraft TCC 1 / TCC 2',
        'https://x.test/012_lego_minecraft_tcc-01_de.jpg'
      ),
      box(
        '/nr.-12-steve-lego-minecraft-tcc-on-fire-2dd00088-12',
        'Nr. 12 Steve LEGO Minecraft TCC 1 "On Fire"',
        'https://x.test/a/TCG3_.P12.jpg'
      ),
    ];
    for (const html of cases) {
      const parsed = parseBlueOceanPage(html);
      expect(parsed).toMatchObject({
        listings: [],
        productCount: 1,
        skippedExcluded: 1,
        skippedNoId: 0,
      });
      // The URL's collection is not read as sold out, and the listing is kept.
      expect(parsed.unreadable.size).toBe(1);
      expect(parsed.unreadableUrls).toHaveLength(1);
    }
  });

  test('a title number other than the URL number gives no id', () => {
    const warn = spyOn(logger, 'warn');
    try {
      for (const [href, title] of [
        [
          `${S1}/nummer-012-i-steve-i-lego-minecraft-tcc-1`,
          'Nummer 013 I Steve I LEGO Minecraft TCC 1',
        ],
        ['/nummer-012-i-alex-00702502-02', 'Nummer 012 I Alex'],
        [`${S2}/steve`, 'Nummer 012 I Steve'],
      ] as const) {
        expect(
          parseBlueOceanPage(box(href, title, 'https://x.test/012_lego_minecraft.jpg'))
        ).toMatchObject({ listings: [], skippedNoId: 1, skippedExcluded: 0 });
      }
      expect(warn.mock.calls.some((c) => String(c[0]).includes('Nummer 013'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('a box without a link is counted invalid, one without a price has none', () => {
    const noLink = box('', 'Nummer 012 I Steve', 'x.jpg').replace(' href=""', '');
    expect(parseBlueOceanPage(noLink)).toMatchObject({ listings: [], skippedInvalid: 1 });
    const noPrice = box(`${S2}/nummer-012-i-steve`, 'Nummer 012 I Steve', 'x.jpg').replace(
      ' aria-label="Preis: 0.8"',
      ' aria-label="Preis auf Anfrage"'
    );
    expect(parseBlueOceanPage(noPrice).listings[0]?.price).toBeNull();
  });

  test('a card picture or URL number without a readable card is counted, naming its collection', () => {
    const warn = spyOn(logger, 'warn');
    try {
      // A root URL of a changed form (a duplicate slug) with a series 1 single's picture.
      const changed = parseBlueOceanPage(
        box(
          '/nummer-012-i-steve-i-lego-minecraft-tcc-1-702351-12-1',
          'Nummer 012 I Steve I LEGO Minecraft TCC 1',
          'https://x.test/012_lego_minecraft_tcc-01_de.jpg'
        )
      );
      expect(changed).toMatchObject({ listings: [], skippedNoId: 1 });
      expect([...changed.unreadable]).toEqual(['lego-minecraft-1']);
      // A root URL with a card number, but a title without `Nummer`.
      const retitled = parseBlueOceanPage(
        box('/nr-12-i-steve-702351-12', 'Nr. 12 I Steve I LEGO Minecraft TCC 1', 'x.jpg')
      );
      expect(retitled).toMatchObject({ listings: [], skippedNoId: 1 });
      expect([...retitled.unreadable]).toEqual(['lego-minecraft-1']);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('no known URL form'))).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('no `Nummer` card number'))).toBe(
        true
      );
    } finally {
      warn.mockRestore();
    }
    // A pack picture names the series but no card number: ignored.
    const pack = parseBlueOceanPage(
      box(
        '/lego-minecraft-boom-bastic-spezial-blister-2dd00037',
        'LEGO Minecraft "Boom-Bastic" Spezial-Blister',
        'https://x.test/LEGO_MineCraft_TCC-02_Blister.png'
      )
    );
    expect(pack).toMatchObject({ listings: [], skippedNoId: 0, skippedExcluded: 0 });
    expect(pack.unreadable.size).toBe(0);
  });

  test("a collection's own exclusion marker does not exclude it", () => {
    const [l] = parseBlueOceanPage(
      box(`${S2}/nummer-012-i-steve`, 'Nummer 012 I Steve I Boom-Bastic', 'x.jpg')
    ).listings;
    expect(l).toMatchObject({ collection: 'lego-minecraft-2', cardIds: ids('12') });
  });

  test('a series 3 card picture at a changed URL form is counted; a pack picture is not', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      const changed = parseBlueOceanPage(
        box(
          '/nr.-12-steve-lego-minecraft-tcc-on-fire-2dd00088-12-1',
          'Nr. 12 Steve LEGO Minecraft TCC "On Fire"',
          'https://x.test/a/LMC_TCG3_.P12.jpg'
        )
      );
      expect(changed).toMatchObject({ listings: [], skippedNoId: 1 });
      expect([...changed.unreadable]).toEqual(['lego-minecraft-3']);
    } finally {
      warn.mockRestore();
    }
    const pack = parseBlueOceanPage(
      box(
        '/lego-minecraft-on-fire-blister-2dd00123',
        'LEGO Minecraft "On Fire" Blister',
        'https://x.test/a/LMC_TCG3_.Blister.jpg'
      )
    );
    expect(pack).toMatchObject({ listings: [], skippedNoId: 0 });
    expect(pack.unreadable.size).toBe(0);
  });

  test('a pack in a series category is no card and not counted', () => {
    const parsed = parseBlueOceanPage(
      box(`${S1}/lego-minecraft-tcc-1-display`, 'LEGO Minecraft TCC 1 - Display', 'x.jpg')
    );
    expect(parsed).toMatchObject({ listings: [], skippedNoId: 0, skippedExcluded: 0 });
  });

  test('a picture number other than the card number is an id conflict', () => {
    const [l] = parseBlueOceanPage(
      box(
        `${S2}/nummer-012-i-steve`,
        'Nummer 012 I Steve',
        'https://x.test/013_lego_minecraft_tcc-02.jpg'
      )
    ).listings;
    expect(l).toMatchObject({
      collection: 'lego-minecraft-2',
      cardIds: ids('12'),
      idConflict: true,
    });
  });

  test('only the given collections are read', () => {
    const s3 = BLUE_OCEAN_COLLECTIONS.filter((c) => c.id === 'lego-minecraft-3');
    const parsed = parseBlueOceanPage(readFixture('blue-ocean-tcc-p2.html'), s3);
    expect(parsed).toMatchObject({ listings: [], skippedExcluded: 0 });
  });
});

describe('createBlueOceanFetcher', () => {
  const base =
    'https://www.blue-ocean.de/produkte/lego/lego-minecraft/lego-minecraft-sticker-cards/';
  const s3 = BLUE_OCEAN_COLLECTIONS.filter((c) => c.id === 'lego-minecraft-3');
  const page = (body: string) => `<div class="cms-page">${body}</div>`;
  const withTotal = (html: string, total: number) =>
    html.replace(/>\s*\d+ Produkte\s*</, `>${total} Produkte<`);
  /** A walk of `pages`, then an empty page; page 1 names the walk's product count as total. */
  function walkOf(pages: string[], total?: number) {
    const urls = new Set(pages.flatMap((p) => parseBlueOceanPage(p).productUrls));
    const [first, ...rest] = pages;
    const withHeader = first!.includes(' Produkte<')
      ? first!
      : first!.replace('<div class="cms-page">', '<div class="cms-page"><div>0 Produkte</div>');
    const entries = [
      withTotal(withHeader, total ?? urls.size),
      ...rest,
      readFixture('blue-ocean-p99.html'),
    ];
    return fakeFetch(Object.fromEntries(entries.map((html, k) => [`?p=${k + 1}`, html])));
  }

  test('throws ShopLayoutError when page 1 is not a shop page', async () => {
    const { fetchFn } = fakeFetch({ '?p=1': '<html>Just a moment...</html>' });
    await expect(
      createBlueOceanFetcher(fetchFn, { delayMs: 0 }).fetchListings()
    ).rejects.toBeInstanceOf(ShopLayoutError);
  });

  test('walks pages until one has no products', async () => {
    const { fetchFn, calls } = walkOf([
      readFixture('blue-ocean-p1.html'),
      readFixture('blue-ocean-p2.html'),
    ]);
    const sleeps: number[] = [];
    const adapter = createBlueOceanFetcher(fetchFn, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(adapter.id).toBe('blue-ocean');
    const { listings } = await adapter.fetchListings();
    expect(calls).toEqual([`${base}?p=1`, `${base}?p=2`, `${base}?p=3`]);
    expect(sleeps).toEqual([1500, 1500]);
    expect(listings.some((l) => l.cardIds[0] === '12')).toBe(true);
    expect(listings.some((l) => l.cardIds[0] === '93')).toBe(true);
  });

  test('the live probe pages pass the walk-total check as they are', async () => {
    // tcc-p31 is the last page of the 2026-11-24 walk; its own total (734) is not met by one page.
    const { fetchFn } = fakeFetch({
      '?p=1': readFixture('blue-ocean-tcc-p31.html'),
      '?p=2': readFixture('blue-ocean-p99.html'),
    });
    const error = await createBlueOceanFetcher(fetchFn, { delayMs: 0 })
      .fetchListings()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect((error as Error).message).toBe(
      'blue-ocean: the walk read 14 products, the category names 734'
    );
  });

  test('a walk reading fewer products than the total (a page cut short) is a layout error', async () => {
    const { fetchFn } = walkOf([readFixture('blue-ocean-p1.html')], 48);
    const error = await createBlueOceanFetcher(fetchFn, { delayMs: 0 })
      .fetchListings()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect((error as Error).message).toContain('read 24 products, the category names 48');
  });

  test('a page 1 without a product total is a layout error', async () => {
    const { fetchFn } = fakeFetch({
      '?p=1': readFixture('blue-ocean-p1.html').replace(/>\s*\d+ Produkte\s*</, '><'),
    });
    const error = await createBlueOceanFetcher(fetchFn, { delayMs: 0 })
      .fetchListings()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect((error as Error).message).toContain('no product total');
  });

  test('reads only the given collections and sums the skipped counts', async () => {
    const { fetchFn } = walkOf([
      readFixture('blue-ocean-tcc-p2.html'),
      readFixture('blue-ocean-p1.html'),
    ]);
    const result = await createBlueOceanFetcher(fetchFn, { delayMs: 0 }, s3).fetchListings();
    expect(result.listings).toHaveLength(19);
    expect(result.listings.every((l) => l.collection === 'lego-minecraft-3')).toBe(true);
    expect(result).toMatchObject({ skippedNoId: 0, skippedExcluded: 0, skippedInvalid: 0 });
  });

  test('one walk serves every collection', async () => {
    const { fetchFn } = walkOf([
      readFixture('blue-ocean-tcc-p2.html'),
      readFixture('blue-ocean-tcc-p31.html'),
      readFixture('blue-ocean-p1.html'),
    ]);
    const result = await createBlueOceanFetcher(fetchFn, { delayMs: 0 }).fetchListings();
    const count = (c: string) => result.listings.filter((l) => l.collection === c).length;
    expect([
      count('lego-minecraft-1'),
      count('lego-minecraft-2'),
      count('lego-minecraft-3'),
    ]).toEqual([14, 13, 19]);
    expect(result.emptyCollections).toBeUndefined();
    expect(result.unreadableUrls).toBeUndefined();
  });

  test('a walk with series 3 cards only reports series 1 and 2 as empty, maybe sold out', async () => {
    const { fetchFn } = walkOf([readFixture('blue-ocean-p1.html')]);
    const result = await createBlueOceanFetcher(fetchFn, { delayMs: 0 }).fetchListings();
    expect(result.listings).toHaveLength(19);
    expect(result.emptyCollections).toEqual(['lego-minecraft-1', 'lego-minecraft-2']);
    expect(result.mayHaveSoldOut).toEqual(['lego-minecraft-1', 'lego-minecraft-2']);
  });

  test('a walk without series 2 cards but with an unreadable series 2 product is no sell-out', async () => {
    const unreadable =
      'https://www.blue-ocean.de/lego/lego-minecraft/trading-card-collection-boom-bastic/1/nummer-012-i-steve';
    const { fetchFn } = walkOf([
      readFixture('blue-ocean-tcc-p2.html').replace(
        /trading-card-collection-boom-bastic/g,
        'trading-card-collection-gone'
      ),
      page(box(new URL(unreadable).pathname, 'Nummer 013 I Steve', 'x.jpg')),
      readFixture('blue-ocean-p1.html'),
    ]);
    const result = await createBlueOceanFetcher(fetchFn, { delayMs: 0 }).fetchListings();
    expect(result.emptyCollections).toEqual(['lego-minecraft-2']);
    expect(result.mayHaveSoldOut).toBeUndefined();
    expect(result.unreadableUrls).toContain(unreadable);
  });

  test('series 3 titles all losing "On Fire" are excluded: no sell-out, URLs unreadable', async () => {
    const retitled = readFixture('blue-ocean-p1.html').replace(/On Fire/g, 'Off');
    const { fetchFn } = walkOf([readFixture('blue-ocean-tcc-p2.html'), retitled]);
    const result = await createBlueOceanFetcher(fetchFn, { delayMs: 0 }).fetchListings();
    expect(result.emptyCollections).toEqual(['lego-minecraft-3']);
    expect(result.mayHaveSoldOut).toBeUndefined();
    expect(result.skippedExcluded).toBe(19);
    expect(result.unreadableUrls).toHaveLength(19);
  });

  test('a failing page request rejects the walk', async () => {
    const { fetchFn } = fakeFetch({});
    await expect(createBlueOceanFetcher(fetchFn, { delayMs: 0 }).fetchListings()).rejects.toThrow();
  });

  test('a walk without any card is a layout error', async () => {
    const { fetchFn } = walkOf([readFixture('blue-ocean-tcc-p2.html')]);
    const error = await createBlueOceanFetcher(fetchFn, { delayMs: 0 }, s3)
      .fetchListings()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect((error as Error).message).toContain('no card listings found on any page');
  });

  test('a bot wall on a later page rejects instead of ending pagination', async () => {
    const { fetchFn } = fakeFetch({
      '?p=1': readFixture('blue-ocean-p1.html'),
      '?p=2': '<html>Just a moment...</html>',
    });
    const error = await createBlueOceanFetcher(fetchFn, { delayMs: 0 })
      .fetchListings()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect((error as Error).message).toContain('page 2');
  });

  test('reaching the page cap is a layout error, never a partial walk', async () => {
    const { fetchFn, calls } = fakeFetch({ '?p=': readFixture('blue-ocean-p1.html') });
    const error = await createBlueOceanFetcher(fetchFn, { delayMs: 0 })
      .fetchListings()
      .catch((e: unknown) => e);
    expect(calls).toHaveLength(60);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect((error as Error).message).toBe('blue-ocean: still products after 60 pages');
    // 60 parsed pages: under coverage on a loaded machine this exceeds the 5 s default.
  }, 30_000);
});
