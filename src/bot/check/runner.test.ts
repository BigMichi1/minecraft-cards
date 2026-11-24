import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { db, initializeDatabase } from '../database/db';
import {
  adminAlerts,
  cards,
  listingCards,
  listings,
  notifications,
  reports,
  runs,
  users,
  wantedCards,
} from '../database/schema/index';
import { catalogManager, SCAN_RETRY_MS } from '../database/catalogManager';
import { listingManager } from '../database/listingManager';
import { runManager } from '../database/runManager';
import { userManager } from '../database/userManager';
import { ImageUnavailableError, ModelError, type ImageEmbedder } from '../matcher/embedder';
import type { LegacyMatchStatus } from '../matcher/matchStatus';
import logger from '../utils/logger';
import { HttpError } from '../utils/http';
import {
  ShopLayoutError,
  type FetchResult,
  type Listing,
  type ShopAdapter,
  type ShopId,
} from '../shops/types';
import {
  rematchText,
  reportRematch,
  runCheck,
  type NotificationSender,
  type PendingNotifications,
  type RunDeps,
  type RunSummary,
  IMAGE_RETRY_MS,
  formatWindow,
} from './runner';
import { cid, ids } from '../../test/cardIds';
import { chosenReference, setCatalogCards } from '../../test/catalog';
import type { CollectionId } from '../collections/ids';

/** A collection outside the registry, to show a run keeps each adapter's collection apart. */
const OTHER = 'other-set' as CollectionId;

const blue12: Listing = {
  shop: 'blue-ocean',
  url: 'https://www.blue-ocean.de/p/12',
  title: 'Sticker Card 12',
  cardIds: [cid('12')],
  cardName: null,
  imageUrl: 'https://img/12.jpg',
  price: { cents: 199, currency: 'EUR' },
  available: true,
  format: 'shop',
  auctionEndsAt: null,
  idConflict: false,
};

let fetchCount = 0;
function ok(
  id: ShopId,
  items: Listing[],
  extra: Omit<FetchResult, 'listings'> = {},
  collection: CollectionId = 'lego-minecraft-3'
): ShopAdapter {
  return {
    id,
    collection,
    fetchListings: async () => {
      fetchCount++;
      return { listings: items, ...extra };
    },
  };
}
function failing(
  id: ShopId,
  error: Error,
  collection: CollectionId = 'lego-minecraft-3'
): ShopAdapter {
  return {
    id,
    collection,
    fetchListings: async () => {
      fetchCount++;
      throw error;
    },
  };
}

class FakeSender implements NotificationSender {
  failing: string | null = null;
  failFor(id: string | null): void {
    this.failing = id;
  }
  async send(pending: PendingNotifications) {
    let notified = 0;
    let dmFailures = 0;
    for (const [discordId, items] of pending) {
      if (discordId === this.failing) {
        dmFailures++;
        continue;
      }
      for (const { listing } of items) {
        listingManager.recordNotified(discordId, listing.id, listing.availableSince!);
      }
      notified++;
    }
    return { notified, dmFailures };
  }
}

describe('runCheck', () => {
  let sender: FakeSender;
  let alerts: string[];
  let clock: number;
  let embedded: string[];
  const embedder: ImageEmbedder = {
    model: 'fake',
    embed: async (url) => {
      embedded.push(url);
      return new Float32Array([1, 0]);
    },
  };

  function depsWith(adapters: ShopAdapter[], over: Partial<RunDeps> = {}): RunDeps {
    clock += 1000;
    return {
      adapters,
      embedder,
      threshold: 0.78,
      sender,
      alertAdmin: async (text) => {
        alerts.push(text);
      },
      now: () => clock,
      intervalMs: 1000,
      ...over,
    };
  }

  beforeAll(() => {
    initializeDatabase();
  });
  beforeEach(() => {
    for (const t of [
      notifications,
      reports,
      listingCards,
      listings,
      wantedCards,
      users,
      cards,
      runs,
      adminAlerts,
    ]) {
      db.delete(t).run();
    }
    catalogManager.seedIfEmpty();
    userManager.setList('u1', 'lego-minecraft-3', '12');
    sender = new FakeSender();
    alerts = [];
    embedded = [];
    clock = 1_000_000;
    fetchCount = 0;
  });

  test("a failing shop for one collection leaves the other collections' listings alone", async () => {
    await runCheck(depsWith([ok('blue-ocean', [blue12])]));
    const s1: Listing = { ...blue12, url: 'https://www.blue-ocean.de/p/s1-12' };
    userManager.setList('u1', 'lego-minecraft-1', '12');
    catalogManager.syncCollection(
      'lego-minecraft-1',
      [
        {
          cardId: cid('12'),
          name: 'X',
          kind: 'Skin Karte',
          variant: 'Basis Karte',
          puzzle: false,
          pictureUrl: null,
        },
      ],
      clock
    );
    await runCheck(
      depsWith([ok('blue-ocean', [blue12]), ok('blue-ocean', [s1], {}, 'lego-minecraft-1')])
    );
    expect(listingManager.getByUrl(s1.url)!.available).toBe(true);
    const s = await runCheck(
      depsWith([
        ok('blue-ocean', [blue12]),
        failing('blue-ocean', new ShopLayoutError('no cards'), 'lego-minecraft-1'),
      ])
    );
    expect(listingManager.getByUrl(blue12.url)!.available).toBe(true);
    expect(listingManager.getByUrl(s1.url)!.available).toBe(true);
    expect(s.shops['blue-ocean']).toEqual({ listings: 1 });
    expect(s.collections?.['lego-minecraft-1']?.['blue-ocean']?.error).toContain('no cards');
    expect(
      alerts.filter((a) => a.startsWith('Shop blue-ocean (LEGO Minecraft Serie 1) check failed'))
    ).toHaveLength(1);
  });

  test('one shop failing in two collections alerts twice and records each apart', async () => {
    const s = await runCheck(
      depsWith([
        failing('sammel-ente', new ShopLayoutError('a')),
        failing('sammel-ente', new ShopLayoutError('b'), 'lego-minecraft-1'),
      ])
    );
    expect(alerts.filter((a) => a.startsWith('Shop sammel-ente ('))).toHaveLength(2);
    expect(s.shops['sammel-ente']?.error).toContain('a');
    expect(s.collections?.['lego-minecraft-1']?.['sammel-ente']?.error).toContain('b');
    expect(runManager.lastAlertAt('shop-error:sammel-ente:lego-minecraft-3')).toBeDefined();
    expect(runManager.lastAlertAt('shop-error:sammel-ente:lego-minecraft-1')).toBeDefined();
  });

  test("the drop check measures each collection's shop against its own peak", async () => {
    const many = (prefix: string, n: number): Listing[] =>
      Array.from({ length: n }, (_, i) => ({
        ...blue12,
        url: `https://www.blue-ocean.de/${prefix}/${i}`,
      }));
    await runCheck(
      depsWith([
        ok('blue-ocean', many('s3', 250)),
        ok('blue-ocean', many('s1', 20), {}, 'lego-minecraft-1'),
      ])
    );
    expect(alerts.filter((a) => a.includes('down from'))).toEqual([]);
    await runCheck(
      depsWith([
        ok('blue-ocean', many('s3', 250)),
        ok('blue-ocean', many('s1', 5), {}, 'lego-minecraft-1'),
      ])
    );
    const drops = alerts.filter((a) => a.includes('down from'));
    expect(drops).toHaveLength(1);
    expect(drops[0]).toStartWith(
      'Shop blue-ocean (LEGO Minecraft Serie 1): 5 card listings, down from 20'
    );
  });

  test("in one run, another collection's copy of a listing is neither matched nor sent", async () => {
    catalogManager.syncCollection(
      'lego-minecraft-1',
      [
        {
          cardId: cid('12'),
          name: 'X',
          kind: 'Skin Karte',
          variant: 'Basis Karte',
          puzzle: false,
          pictureUrl: null,
        },
      ],
      clock
    );
    userManager.setList('u2', 'lego-minecraft-1', '12');
    setCatalogCards('lego-minecraft-3', [{ cardId: cid('12'), imageUrl: 'https://ente/12.jpg' }]);
    const s1Copy: Listing = { ...blue12, imageUrl: 'https://img/s1-copy.jpg' };
    await runCheck(
      depsWith([ok('blue-ocean', [blue12]), ok('blue-ocean', [s1Copy], {}, 'lego-minecraft-1')])
    );
    // Matched with series 3's own picture, not the copy the series 1 adapter returned.
    expect(embedded).toContain(blue12.imageUrl!);
    expect(embedded).not.toContain(s1Copy.imageUrl!);
    const notified = db
      .select()
      .from(notifications)
      .all()
      .map((n) => n.discordId);
    expect(notified).toContain('u1');
    expect(notified).not.toContain('u2');
  });

  test('the foreign-listing alert is throttled, and names at most ten listings', async () => {
    const many: Listing[] = Array.from({ length: 12 }, (_, i) => ({
      ...blue12,
      url: `https://www.blue-ocean.de/p/f${i}`,
    }));
    await runCheck(depsWith([ok('blue-ocean', many)]));
    await runCheck(depsWith([ok('blue-ocean', many, {}, 'lego-minecraft-1')]));
    await runCheck(depsWith([ok('blue-ocean', many, {}, 'lego-minecraft-1')]));
    const foreign = alerts.filter((a) => a.includes('stored under another collection'));
    expect(foreign).toHaveLength(1);
    expect(foreign[0]).toContain('… and 2 more');
    expect(foreign[0]!.length).toBeLessThanOrEqual(2000);
  });

  test('a listing another collection holds is named in one alert, and not read here', async () => {
    await runCheck(depsWith([ok('blue-ocean', [blue12])]));
    await runCheck(depsWith([ok('blue-ocean', [blue12], {}, 'lego-minecraft-1')]));
    const foreign = alerts.filter((a) => a.includes('stored under another collection'));
    expect(foreign).toHaveLength(1);
    // Counted for the collection that holds it, not this one.
    expect(runManager.last()!.collections?.['lego-minecraft-1']?.['blue-ocean']).toEqual({
      listings: 0,
    });
    expect(foreign[0]).toContain(blue12.url);
    expect(runManager.lastAlertAt('shop-foreign:blue-ocean:lego-minecraft-1')).toBeDefined();
  });

  describe('one eBay run for every collection', () => {
    const item = (n: string, collection: CollectionId): Listing => ({
      ...blue12,
      shop: 'ebay',
      url: `https://www.ebay.de/itm/${n}`,
      format: 'fixed_price',
      collection,
    });
    const shared = (
      items: Listing[] | Error,
      more: Omit<FetchResult, 'listings'> = {}
    ): ShopAdapter => ({
      id: 'ebay',
      collection: 'lego-minecraft-3',
      collections: ['lego-minecraft-1', 'lego-minecraft-3'],
      fetchListings: async () => {
        if (items instanceof Error) throw items;
        return { listings: items, ...more };
      },
    });

    test('cut searches alert once under the shop; skipped counts are filed once', async () => {
      const s = await runCheck(
        depsWith([
          shared([item('1', 'lego-minecraft-1')], {
            truncated: ['q (total 1200, read 1000)'],
            skippedNoId: 2,
            skippedExcluded: 3,
          }),
        ])
      );
      expect(alerts.filter((a) => a.includes('cut at the page cap'))).toHaveLength(1);
      expect(runManager.lastAlertAt('shop-truncated:ebay')).toBeDefined();
      expect(runManager.lastAlertAt('shop-truncated:ebay:lego-minecraft-1')).toBeUndefined();
      expect(runManager.lastAlertAt('shop-truncated:ebay:lego-minecraft-3')).toBeUndefined();
      expect(runManager.lastAlertAt('shop-outside:ebay')).toBeUndefined();
      expect(s.shops.ebay).toEqual({
        listings: 0,
        skippedNoId: 2,
        skippedExcluded: 3,
        truncated: 1,
      });
      expect(s.collections?.['lego-minecraft-1']?.ebay).toEqual({ listings: 1 });
    });

    test("a shared run's listing without a collection is stored under the adapter's", async () => {
      const { collection: _named, ...plain } = item('6', 'lego-minecraft-1');
      await runCheck(depsWith([shared([plain as Listing])]));
      expect(listingManager.getByUrl(plain.url)).toMatchObject({ collection: 'lego-minecraft-3' });
    });

    test('an unloaded card list alerts once under the shop, naming the collection', async () => {
      await runCheck(
        depsWith([shared([item('1', 'lego-minecraft-3')], { namesUnknown: ['lego-minecraft-1'] })])
      );
      const names = alerts.filter((a) => a.includes('not read by card name'));
      expect(names).toHaveLength(1);
      expect(names[0]).toContain('LEGO Minecraft Serie 1');
      expect(runManager.lastAlertAt('shop-names:ebay:lego-minecraft-1')).toBeDefined();
    });

    test('a collection whose searches all came back empty keeps its listings, the others are stored', async () => {
      await runCheck(
        depsWith([shared([item('1', 'lego-minecraft-1'), item('3', 'lego-minecraft-3')])])
      );
      clock += 7 * 24 * 60 * 60 * 1000;
      const s = await runCheck(
        depsWith([
          shared([item('3', 'lego-minecraft-3')], {
            emptyCollections: ['lego-minecraft-1'],
            skippedNoId: 2,
          }),
        ])
      );
      expect(listingManager.getByUrl('https://www.ebay.de/itm/1')!.available).toBe(true);
      expect(listingManager.getByUrl('https://www.ebay.de/itm/3')!.lastSeenAt).toBe(clock);
      expect(s.collections?.['lego-minecraft-1']?.ebay).toEqual({
        listings: 0,
        error: 'all searches of LEGO Minecraft Serie 1 returned no usable items',
      });
      expect(s.shops.ebay?.error).toBeUndefined();
      expect(s.shops.ebay).toMatchObject({ skippedNoId: 2 });
      expect(runManager.lastAlertAt('shop-error:ebay:lego-minecraft-1')).toBeDefined();
    });

    test("a shared blue-ocean walk stores each collection and keeps an empty one's listings", async () => {
      const card = (n: string, collection: CollectionId): Listing => ({
        ...blue12,
        url: `https://www.blue-ocean.de/p/${collection}/${n}`,
        collection,
      });
      const walk = (
        items: Listing[] | Error,
        more: Omit<FetchResult, 'listings'> = {}
      ): ShopAdapter => ({
        id: 'blue-ocean',
        collection: 'lego-minecraft-3',
        collections: ['lego-minecraft-1', 'lego-minecraft-2', 'lego-minecraft-3'],
        fetchListings: async () => {
          if (items instanceof Error) throw items;
          return { listings: items, ...more };
        },
      });
      const s1 = card('1', 'lego-minecraft-1');
      // Five series 2 cards: a recent peak at the floor, so an empty walk is not a sell-out.
      const series2 = ['2', '4', '5', '6', '7'].map((n) => card(n, 'lego-minecraft-2'));
      const s2 = series2[0]!;
      const s3 = card('3', 'lego-minecraft-3');
      await runCheck(depsWith([walk([s1, ...series2, s3])]));
      expect(listingManager.getByUrl(s1.url)).toMatchObject({ collection: 'lego-minecraft-1' });
      expect(listingManager.getByUrl(s2.url)).toMatchObject({ collection: 'lego-minecraft-2' });
      expect(listingManager.getByUrl(s3.url)).toMatchObject({ collection: 'lego-minecraft-3' });

      clock += 60 * 60 * 1000;
      const s = await runCheck(
        depsWith([walk([s1, s3], { emptyCollections: ['lego-minecraft-2'], skippedExcluded: 1 })])
      );
      expect(listingManager.getByUrl(s2.url)!.available).toBe(true);
      expect(listingManager.getByUrl(s1.url)!.lastSeenAt).toBe(clock);
      expect(s.collections?.['lego-minecraft-2']?.['blue-ocean']).toEqual({
        listings: 0,
        error: 'no card of LEGO Minecraft Serie 2 "TNT Boom-Bastic" on any page',
      });
      expect(s.shops['blue-ocean']).toEqual({ listings: 1, skippedExcluded: 1 });
      expect(runManager.lastAlertAt('shop-error:blue-ocean:lego-minecraft-2')).toBeDefined();

      clock += 60 * 60 * 1000;
      await runCheck(depsWith([walk(new ShopLayoutError('page 2 is not a category page'))]));
      expect(runManager.lastAlertAt('shop-error:blue-ocean')).toBeDefined();
      expect(listingManager.getByUrl(s1.url)!.available).toBe(true);
    });

    describe('a collection a shared run found nothing of', () => {
      const card = (n: string, collection: CollectionId): Listing => ({
        ...blue12,
        url: `https://www.blue-ocean.de/p/${collection}/${n}`,
        collection,
      });
      const walk = (items: Listing[], more: Omit<FetchResult, 'listings'> = {}): ShopAdapter => ({
        id: 'blue-ocean',
        collection: 'lego-minecraft-3',
        collections: ['lego-minecraft-1', 'lego-minecraft-3'],
        fetchListings: async () => ({ listings: items, ...more }),
      });
      const cards = (n: number, collection: CollectionId) =>
        Array.from({ length: n }, (_, k) => card(String(k + 1), collection));
      const s1 = card('100', 'lego-minecraft-1');
      const soldOut = (c: CollectionId) => ({ emptyCollections: [c], mayHaveSoldOut: [c] });

      test('with fewer than 5 recent listings, it sold out: marked gone, one sold-out alert, no drop alert', async () => {
        const last = cards(4, 'lego-minecraft-3');
        await runCheck(depsWith([walk([s1, ...last])]));
        clock += 60 * 60 * 1000;
        const warn = spyOn(logger, 'warn');
        let s: RunSummary;
        try {
          s = await runCheck(depsWith([walk([s1], soldOut('lego-minecraft-3'))]));
          expect(warn.mock.calls.some((c) => String(c[0]).includes('read as sold out'))).toBe(true);
        } finally {
          warn.mockRestore();
        }
        for (const l of last) expect(listingManager.getByUrl(l.url)!.available).toBe(false);
        expect(s.shops['blue-ocean']).toEqual({ listings: 0 });
        expect(runManager.lastAlertAt('shop-error:blue-ocean:lego-minecraft-3')).toBeUndefined();
        expect(runManager.lastAlertAt('shop-drop:blue-ocean:lego-minecraft-3')).toBeUndefined();
        expect(runManager.lastAlertAt('shop-soldout:blue-ocean:lego-minecraft-3')).toBeDefined();
        expect(alerts.filter((a) => a.includes('read as sold out'))).toHaveLength(1);
      });

      test("another collection than the adapter's sells out the same way, without the run counts", async () => {
        const last = card('1', 'lego-minecraft-1');
        const s3 = card('3', 'lego-minecraft-3');
        await runCheck(depsWith([walk([last, s3])]));
        clock += 60 * 60 * 1000;
        const s = await runCheck(
          depsWith([walk([s3], { ...soldOut('lego-minecraft-1'), skippedNoId: 2 })])
        );
        expect(listingManager.getByUrl(last.url)!.available).toBe(false);
        expect(s.collections?.['lego-minecraft-1']?.['blue-ocean']).toEqual({ listings: 0 });
        expect(s.shops['blue-ocean']).toEqual({ listings: 1, skippedNoId: 2 });
        expect(runManager.lastAlertAt('shop-soldout:blue-ocean:lego-minecraft-1')).toBeDefined();
        expect(runManager.lastAlertAt('shop-soldout:blue-ocean:lego-minecraft-3')).toBeUndefined();
      });

      test('still sold out for the whole window: stored empty, no new alert', async () => {
        const last = card('3', 'lego-minecraft-3');
        await runCheck(depsWith([walk([s1, last])]));
        clock += 60 * 60 * 1000;
        await runCheck(depsWith([walk([s1], soldOut('lego-minecraft-3'))]));
        expect(alerts.filter((a) => a.includes('read as sold out'))).toHaveLength(1);
        // Hourly sold-out runs (0 listings) fill the window; the healthy run falls out of it.
        for (let k = 0; k < 4; k++) {
          clock += 24 * 60 * 60 * 1000;
          await runCheck(depsWith([walk([s1], soldOut('lego-minecraft-3'))]));
        }
        // Throttled daily while the peak still holds the healthy run, silent once it is 0.
        const later = alerts.filter((a) => a.includes('read as sold out')).length;
        clock += 24 * 60 * 60 * 1000;
        const s = await runCheck(depsWith([walk([s1], soldOut('lego-minecraft-3'))]));
        expect(alerts.filter((a) => a.includes('read as sold out'))).toHaveLength(later);
        expect(s.shops['blue-ocean']).toEqual({ listings: 0 });
        expect(runManager.lastAlertAt('shop-error:blue-ocean:lego-minecraft-3')).toBeUndefined();
      });

      test('without a recent successful run, or with an unreadable one, it stays a shop error', async () => {
        const last = card('3', 'lego-minecraft-3');
        await runCheck(depsWith([walk([s1, last])]));
        clock += 4 * 24 * 60 * 60 * 1000;
        const s = await runCheck(depsWith([walk([s1], soldOut('lego-minecraft-3'))]));
        expect(listingManager.getByUrl(last.url)!.available).toBe(true);
        expect(s.shops['blue-ocean']?.error).toBe(
          'no card of LEGO Minecraft Serie 3 "On Fire" on any page (no readable recent listing counts to tell a sell-out; it clears once a check reads a card of it, or no stored listing of it is available)'
        );

        const again = card('4', 'lego-minecraft-3');
        await runCheck(depsWith([walk([s1, again])]));
        const warn = spyOn(logger, 'warn').mockImplementation(() => logger);
        try {
          db.insert(runs).values({ startedAt: clock, finishedAt: clock, summary: '{broken' }).run();
          clock += 60 * 60 * 1000;
          await runCheck(depsWith([walk([s1], soldOut('lego-minecraft-3'))]));
        } finally {
          warn.mockRestore();
        }
        expect(listingManager.getByUrl(again.url)!.available).toBe(true);
        expect(runManager.lastAlertAt('shop-soldout:blue-ocean:lego-minecraft-3')).toBeUndefined();
      });

      test('products the walk could not read keep their listings, with one alert', async () => {
        const kept = card('8', 'lego-minecraft-3');
        const other = card('9', 'lego-minecraft-3');
        await runCheck(depsWith([walk([s1, kept, other])]));
        const before = listingManager.getByUrl(kept.url)!.lastSeenAt;
        clock += 60 * 60 * 1000;
        await runCheck(
          depsWith([
            walk([s1, other], {
              unreadableUrls: [kept.url],
              unreadableCollections: ['lego-minecraft-3'],
            }),
          ])
        );
        expect(listingManager.getByUrl(kept.url)).toMatchObject({
          available: true,
          lastSeenAt: before,
        });
        const unreadable = alerts.filter((a) => a.includes('could not be read'));
        expect(unreadable).toHaveLength(1);
        expect(unreadable[0]).toContain(kept.url);
        expect(runManager.lastAlertAt('shop-unreadable:blue-ocean')).toBeDefined();
        expect(unreadable[0]).toContain('no listing of LEGO Minecraft Serie 3');
      });

      test('a collection with an unreadable product marks none of its listings gone (a moved URL)', async () => {
        const moved = card('8', 'lego-minecraft-3');
        const stays = card('9', 'lego-minecraft-3');
        const s1gone = card('101', 'lego-minecraft-1');
        await runCheck(depsWith([walk([s1, s1gone, moved, stays])]));
        clock += 60 * 60 * 1000;
        await runCheck(
          depsWith([
            walk([s1, stays], {
              unreadableUrls: ['https://www.blue-ocean.de/p/new-form/8'],
              unreadableCollections: ['lego-minecraft-3'],
            }),
          ])
        );
        expect(listingManager.getByUrl(moved.url)!.available).toBe(true);
        // Another collection's gone listings are still marked gone.
        expect(listingManager.getByUrl(s1gone.url)!.available).toBe(false);
      });

      test('without recent counts but with no available listing left, it is stored empty and readable again', async () => {
        const last = card('3', 'lego-minecraft-3');
        await runCheck(depsWith([walk([s1, last])]));
        clock += 60 * 60 * 1000;
        await runCheck(depsWith([walk([s1], soldOut('lego-minecraft-3'))]));
        expect(listingManager.getByUrl(last.url)!.available).toBe(false);
        clock += 4 * 24 * 60 * 60 * 1000;
        const s = await runCheck(depsWith([walk([s1], soldOut('lego-minecraft-3'))]));
        expect(s.shops['blue-ocean']).toEqual({ listings: 0 });
        expect(runManager.lastAlertAt('shop-error:blue-ocean:lego-minecraft-3')).toBeUndefined();
        expect(runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', clock)).toBe(0);
      });

      test('a collection never read before stays a shop error with an alert, never silently sold out', async () => {
        const s = await runCheck(depsWith([walk([s1], soldOut('lego-minecraft-3'))]));
        expect(s.shops['blue-ocean']?.error).toContain('no readable recent listing counts');
        expect(runManager.lastAlertAt('shop-error:blue-ocean:lego-minecraft-3')).toBeDefined();
        clock += 60 * 60 * 1000;
        await runCheck(depsWith([walk([s1], soldOut('lego-minecraft-3'))]));
        expect(
          runManager.shopPeakListings('blue-ocean', 'lego-minecraft-3', clock)
        ).toBeUndefined();
      });

      test('a failing available-listing count keeps it a shop error', async () => {
        const count = spyOn(listingManager, 'listingCounts').mockImplementation(() => {
          throw new Error('database is locked');
        });
        const logged = spyOn(logger, 'log').mockImplementation(() => logger);
        try {
          const s = await runCheck(depsWith([walk([s1], soldOut('lego-minecraft-3'))]));
          expect(s.shops['blue-ocean']?.error).toContain('no readable recent listing counts');
          expect(
            logged.mock.calls.some((c) =>
              String(c[1]).includes('counting the available listings failed')
            )
          ).toBe(true);
        } finally {
          count.mockRestore();
          logged.mockRestore();
        }
      });

      test('with 5 recent listings, or not marked as maybe sold out, it stays a shop error', async () => {
        const five = cards(5, 'lego-minecraft-3');
        await runCheck(depsWith([walk([s1, ...five])]));
        clock += 60 * 60 * 1000;
        await runCheck(depsWith([walk([s1], soldOut('lego-minecraft-3'))]));
        expect(listingManager.getByUrl(five[0]!.url)!.available).toBe(true);
        expect(runManager.lastAlertAt('shop-error:blue-ocean:lego-minecraft-3')).toBeDefined();

        const one = card('1', 'lego-minecraft-1');
        await runCheck(depsWith([walk([one, ...five])]));
        clock += 60 * 60 * 1000;
        await runCheck(depsWith([walk(five, { emptyCollections: ['lego-minecraft-1'] })]));
        expect(listingManager.getByUrl(one.url)!.available).toBe(true);
        expect(runManager.lastAlertAt('shop-error:blue-ocean:lego-minecraft-1')).toBeDefined();
      });

      test('an eBay collection with few listings and empty searches keeps them (eBay never says sold out)', async () => {
        await runCheck(
          depsWith([shared([item('1', 'lego-minecraft-1'), item('3', 'lego-minecraft-3')])])
        );
        clock += 60 * 60 * 1000;
        const s = await runCheck(
          depsWith([
            shared([item('3', 'lego-minecraft-3')], { emptyCollections: ['lego-minecraft-1'] }),
          ])
        );
        expect(listingManager.getByUrl('https://www.ebay.de/itm/1')!.available).toBe(true);
        expect(s.collections?.['lego-minecraft-1']?.ebay?.error).toContain(
          'returned no usable items'
        );
      });

      test('a failing peak lookup keeps it a shop error, its listings kept', async () => {
        const last = card('3', 'lego-minecraft-3');
        await runCheck(depsWith([walk([s1, last])]));
        clock += 60 * 60 * 1000;
        const peak = spyOn(runManager, 'shopPeakListings').mockImplementation(() => {
          throw new Error('database is locked');
        });
        const logged = spyOn(logger, 'log').mockImplementation(() => logger);
        let s: RunSummary;
        try {
          s = await runCheck(depsWith([walk([s1], soldOut('lego-minecraft-3'))]));
          expect(logged.mock.calls.some((c) => String(c[1]).includes('kept as a shop error'))).toBe(
            true
          );
        } finally {
          peak.mockRestore();
          logged.mockRestore();
        }
        expect(listingManager.getByUrl(last.url)!.available).toBe(true);
        expect(s.shops['blue-ocean']?.error).toContain('on any page');
        expect(runManager.lastAlertAt('shop-error:blue-ocean:lego-minecraft-3')).toBeDefined();
      });

      test('an admin-mapped listing placed in an empty collection keeps it from reading as sold out', async () => {
        const mapped = card('7', 'lego-minecraft-3');
        const five = cards(1, 'lego-minecraft-1');
        await runCheck(depsWith([walk([...five, mapped])]));
        listingManager.overrideCards(
          mapped.url,
          { collection: 'lego-minecraft-1', ids: ids('7') },
          clock
        );
        const before = listingManager.getByUrl(mapped.url)!.lastSeenAt;
        clock += 60 * 60 * 1000;
        await runCheck(
          depsWith([walk([card('3', 'lego-minecraft-3'), mapped], soldOut('lego-minecraft-1'))])
        );
        expect(listingManager.getByUrl(mapped.url)).toMatchObject({
          collection: 'lego-minecraft-1',
          lastSeenAt: before,
          available: true,
        });
        expect(listingManager.getByUrl(five[0]!.url)!.available).toBe(true);
      });

      test('empty collections outside the run are warned about and ignored', async () => {
        const warn = spyOn(logger, 'warn');
        try {
          const s = await runCheck(
            depsWith([
              walk([s1, card('3', 'lego-minecraft-3')], {
                emptyCollections: ['lego-minecraft-2'],
                mayHaveSoldOut: ['lego-minecraft-2'],
              }),
            ])
          );
          expect(
            warn.mock.calls.some((c) => String(c[0]).includes("outside the run's collections"))
          ).toBe(true);
          expect(s.collections?.['lego-minecraft-2']).toBeUndefined();
          expect(runManager.lastAlertAt('shop-error:blue-ocean:lego-minecraft-2')).toBeUndefined();
        } finally {
          warn.mockRestore();
        }
      });
    });

    test('an admin-mapped listing in a collection the run does not cover is left alone, with no foreign alert', async () => {
      const s2: Listing = item('9', 'lego-minecraft-3');
      listingManager.upsertFromRun('ebay', 'lego-minecraft-2', [s2], clock);
      listingManager.overrideCards(
        s2.url,
        { collection: 'lego-minecraft-2', ids: ids('12') },
        clock
      );
      const before = listingManager.getByUrl(s2.url)!.lastSeenAt;
      const warn = spyOn(logger, 'warn').mockImplementation(() => logger);
      try {
        await runCheck(depsWith([shared([s2])]));
        expect(
          warn.mock.calls.some((c: unknown[]) =>
            String(c[0]).includes('does not cover, left unchanged')
          )
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
      expect(listingManager.getByUrl(s2.url)).toMatchObject({
        collection: 'lego-minecraft-2',
        lastSeenAt: before,
      });
      expect(alerts.filter((a) => a.includes('stored under another collection'))).toEqual([]);
      const outside = alerts.filter((a) => a.includes('does not cover are left as they are'));
      expect(outside).toHaveLength(1);
      expect(outside[0]).toContain(s2.url);
      expect(runManager.lastAlertAt('shop-outside:ebay')).toBeDefined();
    });

    test('the unloaded card list key names its collections in a fixed order', async () => {
      await runCheck(
        depsWith([
          shared([item('1', 'lego-minecraft-3')], {
            namesUnknown: ['lego-minecraft-2', 'lego-minecraft-1'],
          }),
        ])
      );
      expect(
        runManager.lastAlertAt('shop-names:ebay:lego-minecraft-1,lego-minecraft-2')
      ).toBeDefined();
    });

    test("series 3's store failing: the run's counts are still filed under it", async () => {
      const real = listingManager.upsertFromRun.bind(listingManager);
      const upsert = spyOn(listingManager, 'upsertFromRun').mockImplementation(
        (shop, collection, ...rest) => {
          if (collection === 'lego-minecraft-3') throw new Error('disk full');
          return real(shop, collection, ...rest);
        }
      );
      const log = spyOn(logger, 'log').mockImplementation(() => logger);
      let s: RunSummary;
      try {
        s = await runCheck(
          depsWith([shared([item('1', 'lego-minecraft-1')], { skippedExcluded: 3 })])
        );
      } finally {
        upsert.mockRestore();
        log.mockRestore();
      }
      expect(s.shops.ebay).toMatchObject({ skippedExcluded: 3 });
      expect(s.shops.ebay?.error).toContain('disk full');
      expect(s.collections?.['lego-minecraft-1']?.ebay).toEqual({ listings: 1 });
    });

    test("another collection's store failing files no run counts there", async () => {
      const real = listingManager.upsertFromRun.bind(listingManager);
      const upsert = spyOn(listingManager, 'upsertFromRun').mockImplementation(
        (shop, collection, ...rest) => {
          if (collection === 'lego-minecraft-1') throw new Error('disk full');
          return real(shop, collection, ...rest);
        }
      );
      const log = spyOn(logger, 'log').mockImplementation(() => logger);
      let s: RunSummary;
      try {
        s = await runCheck(
          depsWith([shared([item('1', 'lego-minecraft-1')], { skippedExcluded: 3 })])
        );
      } finally {
        upsert.mockRestore();
        log.mockRestore();
      }
      expect(s.collections?.['lego-minecraft-1']?.ebay).toEqual({
        listings: 1,
        error: expect.stringContaining('disk full'),
      });
      expect(s.shops.ebay).toMatchObject({ skippedExcluded: 3 });
      expect(s.shops.ebay?.error).toBeUndefined();
    });

    test("series 3's searches all empty: the run's counts are still filed under it", async () => {
      const s = await runCheck(
        depsWith([
          shared([item('1', 'lego-minecraft-1')], {
            emptyCollections: ['lego-minecraft-3'],
            skippedNoId: 4,
            truncated: ['q (cut)'],
          }),
        ])
      );
      expect(s.shops.ebay).toMatchObject({ listings: 0, skippedNoId: 4, truncated: 1 });
      expect(s.shops.ebay?.error).toContain('returned no usable items');
      expect(s.collections?.['lego-minecraft-1']?.ebay).toEqual({ listings: 1 });
    });

    test("in a shared run, another shop's listing under that URL still raises the foreign alert", async () => {
      const url = 'https://www.ebay.de/itm/10';
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-1', [{ ...blue12, url }], clock);
      await runCheck(depsWith([shared([item('10', 'lego-minecraft-3')])]));
      const foreign = alerts.filter((a) => a.includes('stored under another collection'));
      expect(foreign).toHaveLength(1);
      expect(foreign[0]).toContain('stored by another shop or mapped during this run');
      expect(runManager.lastAlertAt('shop-foreign:ebay:lego-minecraft-3')).toBeDefined();
    });

    test('a failure placing the listings is a shop error of every collection, not a run error', async () => {
      await runCheck(depsWith([shared([item('1', 'lego-minecraft-1')])]));
      clock += 7 * 24 * 60 * 60 * 1000;
      const read = spyOn(listingManager, 'getByUrl').mockImplementation(() => {
        throw new Error('database is locked');
      });
      const log = spyOn(logger, 'log').mockImplementation(() => logger);
      let s: RunSummary;
      try {
        s = await runCheck(depsWith([shared([item('1', 'lego-minecraft-1')])]));
      } finally {
        read.mockRestore();
        log.mockRestore();
      }
      expect(s.shops.ebay?.error).toContain('database is locked');
      expect(s.collections?.['lego-minecraft-1']?.ebay?.error).toContain('database is locked');
      expect(alerts.filter((a) => a.startsWith('Shop ebay check failed'))).toHaveLength(1);
      expect(runManager.lastAlertAt('shop-error:ebay')).toBeDefined();
      expect(s.shops.ebay?.error).toContain('placing listings failed');
      // Nothing stored this run: the listing stays available.
      expect(listingManager.getByUrl('https://www.ebay.de/itm/1')!.available).toBe(true);
    });

    test('a moved listing alerts the new collection once, and not the old one again', async () => {
      catalogManager.syncCollection(
        'lego-minecraft-1',
        [
          {
            cardId: cid('12'),
            name: 'X',
            kind: 'Skin Karte',
            variant: 'Basis Karte',
            puzzle: false,
            pictureUrl: null,
          },
        ],
        clock
      );
      setCatalogCards('lego-minecraft-1', [
        { cardId: cid('12'), imageUrl: 'https://ente/s1-12.jpg' },
      ]);
      setCatalogCards('lego-minecraft-3', [{ cardId: cid('12'), imageUrl: 'https://ente/12.jpg' }]);
      userManager.setList('u2', 'lego-minecraft-1', '12');
      const sentTo = () =>
        db
          .select()
          .from(notifications)
          .all()
          .map((n) => n.discordId)
          .sort();
      await runCheck(depsWith([shared([item('8', 'lego-minecraft-3')])]));
      expect(sentTo()).toEqual(['u1']);
      await runCheck(depsWith([shared([item('8', 'lego-minecraft-1')])]));
      await runCheck(depsWith([shared([item('8', 'lego-minecraft-1')])]));
      expect(sentTo()).toEqual(['u1', 'u2']);
    });

    test("one eBay run stores each collection's listings and marks each one's gone ones", async () => {
      const s = await runCheck(
        depsWith([shared([item('1', 'lego-minecraft-1'), item('3', 'lego-minecraft-3')])])
      );
      expect(listingManager.getByUrl('https://www.ebay.de/itm/1')).toMatchObject({
        collection: 'lego-minecraft-1',
      });
      expect(listingManager.getByUrl('https://www.ebay.de/itm/3')).toMatchObject({
        collection: 'lego-minecraft-3',
      });
      expect(s.shops.ebay).toEqual({ listings: 1 });
      expect(s.collections?.['lego-minecraft-1']?.ebay).toEqual({ listings: 1 });
      // A later run without the series 1 listing, past eBay's grace: series 1's is gone.
      clock += 7 * 24 * 60 * 60 * 1000;
      await runCheck(depsWith([shared([item('3', 'lego-minecraft-3')])]));
      expect(listingManager.getByUrl('https://www.ebay.de/itm/1')!.available).toBe(false);
      expect(listingManager.getByUrl('https://www.ebay.de/itm/3')!.available).toBe(true);
    });

    test('a failing eBay run touches no collection and alerts once', async () => {
      await runCheck(
        depsWith([shared([item('1', 'lego-minecraft-1'), item('3', 'lego-minecraft-3')])])
      );
      clock += 7 * 24 * 60 * 60 * 1000;
      const s = await runCheck(depsWith([shared(new ShopLayoutError('eBay: all searches empty'))]));
      expect(listingManager.getByUrl('https://www.ebay.de/itm/1')!.available).toBe(true);
      expect(listingManager.getByUrl('https://www.ebay.de/itm/3')!.available).toBe(true);
      expect(alerts.filter((a) => a.startsWith('Shop ebay check failed'))).toHaveLength(1);
      expect(runManager.lastAlertAt('shop-error:ebay')).toBeDefined();
      expect(s.collections?.['lego-minecraft-1']?.ebay?.error).toContain('all searches empty');
      expect(s.shops.ebay?.error).toContain('all searches empty');
    });

    test('an admin-mapped listing is kept fresh where the admin put it, whatever its title names', async () => {
      await runCheck(depsWith([shared([item('7', 'lego-minecraft-3')])]));
      listingManager.overrideCards(
        'https://www.ebay.de/itm/7',
        { collection: 'lego-minecraft-3', ids: ids('12') },
        clock
      );
      clock += 7 * 24 * 60 * 60 * 1000;
      await runCheck(depsWith([shared([item('7', 'lego-minecraft-1')])]));
      expect(listingManager.getByUrl('https://www.ebay.de/itm/7')).toMatchObject({
        collection: 'lego-minecraft-3',
        cardIds: ids('12'),
        available: true,
        lastSeenAt: clock,
      });
    });

    test('a listing whose title now names another collection moves there', async () => {
      await runCheck(depsWith([shared([item('9', 'lego-minecraft-3')])]));
      await runCheck(depsWith([shared([item('9', 'lego-minecraft-1')])]));
      expect(listingManager.getByUrl('https://www.ebay.de/itm/9')).toMatchObject({
        collection: 'lego-minecraft-1',
      });
      expect(alerts.filter((a) => a.includes('stored under another collection'))).toEqual([]);
    });
  });

  test('a failing shop keeps its stored state and alerts once per 24 h', async () => {
    await runCheck(depsWith([ok('blue-ocean', [blue12])]));
    const failed = () => failing('blue-ocean', new ShopLayoutError('no cards'));
    const s = await runCheck(depsWith([failed()]));
    expect(s.shops['blue-ocean']!.error).toContain('no cards');
    expect(listingManager.getByUrl(blue12.url)!.available).toBe(true);
    expect(alerts).toHaveLength(1);
    await runCheck(depsWith([failed()]));
    expect(alerts).toHaveLength(1);
    clock += 25 * 60 * 60 * 1000;
    await runCheck(depsWith([failed()]));
    expect(alerts).toHaveLength(2);
  });

  test('a DM failure for one user does not block others and is retried next run', async () => {
    userManager.setList('u2', 'lego-minecraft-3', '12');
    sender.failFor('u1');
    const r = await runCheck(depsWith([ok('blue-ocean', [blue12])]));
    expect(r.notified).toBe(1);
    expect(r.dmFailures).toBe(1);
    sender.failFor(null);
    const again = await runCheck(depsWith([ok('blue-ocean', [blue12])]));
    expect(again.notified).toBe(1);
    expect((await runCheck(depsWith([ok('blue-ocean', [blue12])]))).notified).toBe(0);
  });

  test('every run retries the admin DMs of reports that failed, even with no wanted cards', async () => {
    userManager.clearList('u1', 'lego-minecraft-3');
    let retries = 0;
    await runCheck(depsWith([], { retryReports: async () => void retries++ }));
    expect(retries).toBe(1);
  });

  test('a rejecting retryReports is logged and does not fail the run', async () => {
    const log = spyOn(logger, 'log');
    try {
      const s = await runCheck(
        depsWith([ok('blue-ocean', [blue12])], {
          retryReports: async () => {
            throw new Error('reports table locked');
          },
        })
      );
      expect(s.error).toBeUndefined();
      expect(runManager.last()).toEqual(s);
      expect(
        log.mock.calls.some((c: unknown[]) => String(c[1]).includes('retrying report DMs failed'))
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test('the catalog sync runs before the first shop, and a failing one stops nothing', async () => {
    const order: string[] = [];
    const shop: ShopAdapter = {
      id: 'blue-ocean',
      collection: 'lego-minecraft-3',
      fetchListings: async () => {
        order.push('shop');
        return { listings: [blue12] };
      },
    };
    await runCheck(
      depsWith([shop], {
        syncCatalogs: async () => {
          order.push('sync');
        },
      })
    );
    expect(order).toEqual(['sync', 'shop']);
    const s = await runCheck(
      depsWith([shop], {
        syncCatalogs: async () => {
          throw new Error('laststicker down');
        },
      })
    );
    expect(order).toEqual(['sync', 'shop', 'shop']);
    expect(s.error).toBeUndefined();
  });

  test('the catalog syncs even when nobody wants a card', async () => {
    userManager.clearList('u1', 'lego-minecraft-3');
    let synced = 0;
    await runCheck(
      depsWith([], {
        syncCatalogs: async () => {
          synced++;
        },
      })
    );
    expect(synced).toBe(1);
  });

  test('no wanted cards means no fetch but the run is recorded', async () => {
    userManager.clearList('u1', 'lego-minecraft-3');
    const s = await runCheck(depsWith([ok('blue-ocean', [blue12])]));
    expect(fetchCount).toBe(0);
    expect(s.shops).toEqual({});
    expect(runManager.last()).toEqual(s);
  });

  test('sammel-ente listings update reference images, never names', async () => {
    const ente: Listing = {
      ...blue12,
      shop: 'sammel-ente',
      url: 'https://shop-sammel-ente.de/12',
      cardName: 'Creeper',
      imageUrl: 'https://ente/12.jpg',
    };
    await runCheck(depsWith([ok('sammel-ente', [ente])]));
    const card = catalogManager.getCard('lego-minecraft-3', cid('12'))!;
    expect(card.name).toBeNull();
    // The card has no scan yet: the shop picture is its reference.
    expect(catalogManager.referenceCatalog('lego-minecraft-3').usable).toContainEqual({
      cardId: cid('12'),
      referenceImageUrl: 'https://ente/12.jpg',
      source: 'shop',
      fallbackUrl: null,
      puzzle: false,
    });
  });

  describe('missing and returning scans', () => {
    const scan = 'https://www.laststicker.com/i/cards/12125/12.jpg';
    const gone = () =>
      new ImageUnavailableError(`HTTP 404 for ${scan}`, { cause: new HttpError(404, scan) });
    const noScan: ImageEmbedder = {
      model: 'fake',
      embed: async (url) => {
        embedded.push(url);
        if (url === scan) throw gone();
        return new Float32Array([1, 0]);
      },
    };

    test("a missing scan alerts the admin once and compares the card's mismatches again", async () => {
      setCatalogCards('lego-minecraft-3', [
        { cardId: cid('12'), scanUrl: scan, imageUrl: 'https://ente/12.jpg' },
      ]);
      const rematch = spyOn(listingManager, 'rematchMismatches');
      try {
        await runCheck(depsWith([ok('blue-ocean', [blue12])], { embedder: noScan }));
        expect(rematch).toHaveBeenCalledWith('lego-minecraft-3', ids('12'));
      } finally {
        rematch.mockRestore();
      }
      const scanAlerts = alerts.filter((a) => a.includes('no laststicker scan'));
      expect(scanAlerts).toHaveLength(1);
      expect(scanAlerts[0]).toContain('#12');
    });

    test('a missing scan without a shop picture leaves the title card without a reference', async () => {
      setCatalogCards('lego-minecraft-3', [{ cardId: cid('12'), scanUrl: scan }]);
      await runCheck(depsWith([ok('blue-ocean', [blue12])], { embedder: noScan }));
      expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('no_reference');
      expect(embedded.filter((u) => u === scan)).toHaveLength(1);
      expect(alerts.filter((a) => a.includes('no laststicker scan'))[0]).toContain(
        'now without any reference: #12'
      );
    });

    test('a failing record of a missing scan is logged; the run still uses the fallback', async () => {
      setCatalogCards('lego-minecraft-3', [
        { cardId: cid('12'), scanUrl: scan, imageUrl: 'https://ente/12.jpg' },
      ]);
      const mark = spyOn(catalogManager, 'markScanMissing').mockImplementation(() => {
        throw new Error('db locked');
      });
      const log = spyOn(logger, 'log');
      try {
        await runCheck(depsWith([ok('blue-ocean', [blue12])], { embedder: noScan }));
        expect(listingManager.getByUrl(blue12.url)).toMatchObject({ matchStatus: 'confirmed' });
        expect(
          log.mock.calls.some((c: unknown[]) =>
            String(c[1]).includes('recording the missing scan of #12 failed')
          )
        ).toBe(true);
      } finally {
        mark.mockRestore();
        log.mockRestore();
      }
      expect(catalogManager.referenceCatalog('lego-minecraft-3', clock).usable).toContainEqual(
        expect.objectContaining({ cardId: cid('12'), source: 'laststicker' })
      );
    });

    const notifiedUrls = () =>
      db
        .select({ url: listings.url })
        .from(notifications)
        .innerJoin(listings, eq(listings.id, notifications.listingId))
        .all()
        .map((r) => r.url);

    test('a mismatch reset by a missing scan is not sent to users in the same run', async () => {
      setCatalogCards('lego-minecraft-3', [
        { cardId: cid('12'), scanUrl: scan, imageUrl: 'https://ente/12.jpg' },
      ]);
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], clock);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(
        l.id,
        { status: 'mismatch', similarity: 0.4, picture: { cardId: cid('45'), similarity: 0.95 } },
        clock
      );
      // Another listing needs comparing, so the run loads the references (and finds the 404).
      userManager.setList('u1', 'lego-minecraft-3', '12, 13');
      setCatalogCards('lego-minecraft-3', [{ cardId: cid('13'), imageUrl: 'https://ente/13.jpg' }]);
      const blue13: Listing = {
        ...blue12,
        url: 'https://www.blue-ocean.de/p/13',
        cardIds: [cid('13')],
        available: false,
      };
      await runCheck(
        depsWith([ok('blue-ocean', [blue12, { ...blue13, available: true }])], { embedder: noScan })
      );
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        matchStatus: 'pending',
        rematchFrom: 'mismatch',
      });
      expect(notifiedUrls()).not.toContain(blue12.url);
    });

    test('a failing re-match of a returning scan keeps its record, to be tried again', async () => {
      setCatalogCards('lego-minecraft-3', [
        { cardId: cid('12'), scanUrl: scan, imageUrl: 'https://ente/12.jpg' },
      ]);
      catalogManager.markScanMissing('lego-minecraft-3', cid('12'), clock - SCAN_RETRY_MS - 5000);
      const rematch = spyOn(listingManager, 'rematchMismatches').mockImplementation(() => {
        throw new Error('db locked');
      });
      const log = spyOn(logger, 'log');
      try {
        await runCheck(depsWith([ok('blue-ocean', [blue12])]));
        expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('confirmed');
        expect(
          log.mock.calls.some((c: unknown[]) =>
            String(c[1]).includes(
              're-matching the cards of lego-minecraft-3 whose scans loaded again failed'
            )
          )
        ).toBe(true);
      } finally {
        rematch.mockRestore();
        log.mockRestore();
      }
      expect(catalogManager.markedScans('lego-minecraft-3', ids('12'))).toEqual(ids('12'));
    });

    test('a failing re-match of a first missing scan records nothing and says so', async () => {
      setCatalogCards('lego-minecraft-3', [
        { cardId: cid('12'), scanUrl: scan, imageUrl: 'https://ente/12.jpg' },
      ]);
      const rematch = spyOn(listingManager, 'rematchMismatches').mockImplementation(() => {
        throw new Error('db locked');
      });
      try {
        await runCheck(depsWith([ok('blue-ocean', [blue12])], { embedder: noScan }));
      } finally {
        rematch.mockRestore();
      }
      expect(catalogManager.markedScans('lego-minecraft-3', ids('12'))).toEqual([]);
      expect(alerts.find((a) => a.includes('laststicker scans'))).toContain(
        'could not be recorded, tried again next run: #12'
      );
    });

    test('a scan that stays missing is fetched and alerted once, and its retry changes nothing', async () => {
      setCatalogCards('lego-minecraft-3', [
        { cardId: cid('12'), scanUrl: scan, imageUrl: 'https://ente/12.jpg' },
      ]);
      await runCheck(depsWith([ok('blue-ocean', [blue12])], { embedder: noScan }));
      // Next day: the shop picture is the reference, the scan is not asked for.
      clock += 25 * 60 * 60 * 1000;
      listingManager.upsertFromRun(
        'blue-ocean',
        'lego-minecraft-3',
        [{ ...blue12, imageUrl: 'https://img/12b.jpg' }],
        clock
      );
      await runCheck(
        depsWith([ok('blue-ocean', [{ ...blue12, imageUrl: 'https://img/12b.jpg' }])], {
          embedder: noScan,
        })
      );
      expect(embedded.filter((u) => u === scan)).toHaveLength(1);
      // After SCAN_RETRY_MS it answers 404 again: no change, no new alert, no re-match.
      clock += SCAN_RETRY_MS;
      const rematch = spyOn(listingManager, 'rematchMismatches');
      try {
        await runCheck(
          depsWith([ok('blue-ocean', [{ ...blue12, imageUrl: 'https://img/12c.jpg' }])], {
            embedder: noScan,
          })
        );
        expect(rematch).not.toHaveBeenCalledWith('lego-minecraft-3', ids('12'));
      } finally {
        rematch.mockRestore();
      }
      expect(embedded.filter((u) => u === scan)).toHaveLength(2);
      expect(alerts.filter((a) => a.includes('no laststicker scan'))).toHaveLength(1);
    });

    test('a scan missing later the same day is alerted too', async () => {
      const scan13 = 'https://www.laststicker.com/i/cards/12125/13.jpg';
      setCatalogCards('lego-minecraft-3', [
        { cardId: cid('12'), scanUrl: scan, imageUrl: 'https://ente/12.jpg' },
        { cardId: cid('13'), scanUrl: scan13, imageUrl: 'https://ente/13.jpg' },
      ]);
      let gone13 = false;
      const later: ImageEmbedder = {
        model: 'fake',
        embed: async (url) => {
          if (url === scan || (gone13 && url === scan13)) {
            throw new ImageUnavailableError(`HTTP 404 for ${url}`, {
              cause: new HttpError(404, url),
            });
          }
          return new Float32Array([1, 0]);
        },
      };
      await runCheck(depsWith([ok('blue-ocean', [blue12])], { embedder: later }));
      gone13 = true;
      clock += 3 * 60 * 60 * 1000;
      await runCheck(
        depsWith([ok('blue-ocean', [{ ...blue12, imageUrl: 'https://img/12-later.jpg' }])], {
          embedder: later,
        })
      );
      const scanAlerts = alerts.filter((a) => a.includes('no laststicker scan'));
      expect(scanAlerts).toHaveLength(2);
      expect(scanAlerts[1]).toContain('#13');
    });

    test('more than ten missing scans are named with how many more', async () => {
      const lost = Array.from({ length: 12 }, (_, i) => String(i + 1));
      setCatalogCards(
        'lego-minecraft-3',
        lost.map((id) => ({
          cardId: cid(id),
          scanUrl: `https://www.laststicker.com/i/cards/12125/${id}.jpg`,
        }))
      );
      const allGone: ImageEmbedder = {
        model: 'fake',
        embed: async (url) => {
          if (url.includes('laststicker')) {
            throw new ImageUnavailableError(`HTTP 404 for ${url}`, {
              cause: new HttpError(404, url),
            });
          }
          return new Float32Array([1, 0]);
        },
      };
      await runCheck(depsWith([ok('blue-ocean', [blue12])], { embedder: allGone }));
      const text = alerts.find((a) => a.includes('no laststicker scan'))!;
      expect(text).toContain('12 card(s)');
      expect(text).toContain('#10 … and 2 more');
      expect(text).toContain('now without any reference: #1, #2');
    });

    test('a scan that loads again after its retry clears the mark and re-matches the card', async () => {
      setCatalogCards('lego-minecraft-3', [
        { cardId: cid('12'), scanUrl: scan, imageUrl: 'https://ente/12.jpg' },
      ]);
      catalogManager.markScanMissing('lego-minecraft-3', cid('12'), clock - SCAN_RETRY_MS - 5000);
      const rematch = spyOn(listingManager, 'rematchMismatches');
      try {
        await runCheck(depsWith([ok('blue-ocean', [blue12])]));
        expect(rematch).toHaveBeenCalledWith('lego-minecraft-3', ids('12'));
      } finally {
        rematch.mockRestore();
      }
      expect(embedded).toContain(scan);
      // Cleared: a later 404 starts a new 7-day window.
      expect(catalogManager.clearScanMissing('lego-minecraft-3', ids('12'))).toEqual([]);
    });
  });

  test('a missing scan is recorded and the title card is compared with the fallback in the same run', async () => {
    const scan = 'https://www.laststicker.com/i/cards/12125/12.jpg';
    setCatalogCards('lego-minecraft-3', [
      { cardId: cid('12'), scanUrl: scan, imageUrl: 'https://ente/12.jpg' },
    ]);
    const noScan: ImageEmbedder = {
      model: 'fake',
      embed: async (url) => {
        embedded.push(url);
        if (url === scan) {
          throw new ImageUnavailableError(`HTTP 404 for ${url}`, {
            cause: new HttpError(404, url),
          });
        }
        return new Float32Array([1, 0]);
      },
    };
    await runCheck(depsWith([ok('blue-ocean', [blue12])], { embedder: noScan }));
    expect(listingManager.getByUrl(blue12.url)).toMatchObject({
      matchStatus: 'confirmed',
      similarity: 1,
    });
    expect(embedded).toContain('https://ente/12.jpg');
    expect(alerts.filter((a) => a.includes('could not be loaded'))).toEqual([]);
    // Recorded: later runs (and the DM thumbnails) take the shop picture directly.
    expect(catalogManager.referenceCatalog('lego-minecraft-3', clock).usable).toContainEqual(
      expect.objectContaining({ cardId: cid('12'), source: 'shop' })
    );
  });

  test('a failing re-match after new shop pictures alerts the admin with the cards', async () => {
    const ente: Listing = {
      ...blue12,
      shop: 'sammel-ente',
      url: 'https://shop-sammel-ente.de/12',
      imageUrl: 'https://ente/12.jpg',
    };
    const rematch = spyOn(listingManager, 'rematchMismatches').mockImplementation(() => {
      throw new Error('db locked');
    });
    try {
      const s = await runCheck(depsWith([ok('sammel-ente', [ente])]));
      expect(s.shops['sammel-ente']).toEqual({ listings: 1 });
      expect(
        alerts.some((a) => a.includes('could not compare the mismatches of 1 card(s) again: #12'))
      ).toBe(true);
    } finally {
      rematch.mockRestore();
    }
  });

  test("a new shop picture of a card whose scan is missing re-matches it at the run's time", async () => {
    setCatalogCards('lego-minecraft-3', [
      { cardId: cid('12'), scanUrl: 'https://www.laststicker.com/i/cards/12125/12.jpg' },
    ]);
    // Recorded at the run's clock, far from Date.now(): the run must judge by its own clock.
    catalogManager.markScanMissing('lego-minecraft-3', cid('12'), clock);
    const rematch = spyOn(listingManager, 'rematchMismatches');
    try {
      await runCheck(
        depsWith([
          ok('sammel-ente', [
            {
              ...blue12,
              shop: 'sammel-ente',
              url: 'https://shop-sammel-ente.de/12',
              imageUrl: 'https://ente/12.jpg',
            },
          ]),
        ])
      );
      expect(rematch).toHaveBeenCalledWith('lego-minecraft-3', ids('12'));
    } finally {
      rematch.mockRestore();
    }
  });

  test('a failing re-match after many new shop pictures names ten and counts the rest', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => String(i + 1));
    const enteListings: Listing[] = twelve.map((id) => ({
      ...blue12,
      shop: 'sammel-ente',
      url: `https://shop-sammel-ente.de/${id}`,
      cardIds: [cid(id)],
      imageUrl: `https://ente/${id}.jpg`,
    }));
    const rematch = spyOn(listingManager, 'rematchMismatches').mockImplementation(() => {
      throw new Error('db locked');
    });
    try {
      await runCheck(depsWith([ok('sammel-ente', enteListings)]));
    } finally {
      rematch.mockRestore();
    }
    expect(
      alerts.find((a) => a.includes('could not compare the mismatches of 12 card(s)'))
    ).toContain('#10 … and 2 more');
  });

  test('a sammel-ente listing stored under another collection gives this one no picture', async () => {
    const ente: Listing = {
      ...blue12,
      shop: 'sammel-ente',
      url: 'https://shop-sammel-ente.de/12',
      imageUrl: 'https://ente/12.jpg',
    };
    await runCheck(depsWith([ok('sammel-ente', [ente])]));
    catalogManager.syncCollection(
      'lego-minecraft-1',
      [
        {
          cardId: cid('12'),
          name: 'X',
          kind: 'Skin Karte',
          variant: 'Basis Karte',
          puzzle: false,
          pictureUrl: null,
        },
      ],
      clock
    );
    // The same URL in the series 1 category: a series 3 listing, skipped there.
    await runCheck(depsWith([ok('sammel-ente', [ente], {}, 'lego-minecraft-1')]));
    expect(chosenReference('lego-minecraft-1', cid('12'))).toBeNull();
  });

  test("only the collection's fallback shop writes shop pictures", async () => {
    await runCheck(depsWith([ok('blue-ocean', [blue12])]));
    expect(chosenReference('lego-minecraft-3', cid('12'))).toBeNull();
  });

  test('each adapter stores, names and matches in its own collection', async () => {
    const ente: Listing = {
      ...blue12,
      shop: 'sammel-ente',
      url: 'https://shop-sammel-ente.de/12',
      cardName: 'Creeper',
      imageUrl: 'https://ente/12.jpg',
    };
    userManager.setList('u1', 'lego-minecraft-3', '12');
    const s = await runCheck(
      depsWith([ok('sammel-ente', [ente], {}, OTHER), ok('blue-ocean', [blue12], {}, OTHER)])
    );
    expect(catalogManager.getCard('lego-minecraft-3', cid('12'))!.name).toBeNull();
    expect(listingManager.getByUrl(blue12.url)).toMatchObject({
      collection: OTHER,
      matchStatus: 'pending',
    });
    expect(embedded).toEqual([]);
    expect(s.notified).toBe(0);
  });

  test("a listing is compared with its own collection's references only", async () => {
    setCatalogCards('lego-minecraft-3', [
      { cardId: cid('12'), name: 'Creeper', imageUrl: 'https://ente/12.jpg' },
    ]);
    db.insert(cards)
      .values({
        collection: OTHER,
        cardId: cid('12'),
        type: 'base',
        shopImageUrl: 'https://o/12.jpg',
        updatedAt: 1,
      })
      .run();
    db.insert(users).values({ discordId: 'u9', createdAt: 1 }).run();
    db.insert(wantedCards)
      .values({ discordId: 'u9', collection: OTHER, cardId: cid('12') })
      .run();
    await runCheck(depsWith([ok('blue-ocean', [blue12], {}, OTHER)]));
    expect(embedded).toContain('https://o/12.jpg');
    expect(embedded).toContain(blue12.imageUrl!);
    expect(embedded).not.toContain('https://ente/12.jpg');
    expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('confirmed');
  });

  test('a sammel-ente listing with several ids leaves the catalog alone', async () => {
    const nameless: Listing = {
      ...blue12,
      shop: 'sammel-ente',
      url: 'https://shop-sammel-ente.de/x',
      cardName: null,
      imageUrl: 'https://ente/x.jpg',
    };
    const several: Listing = {
      ...nameless,
      url: 'https://shop-sammel-ente.de/y',
      cardIds: [cid('12'), cid('13')],
      cardName: 'Two',
    };
    await runCheck(depsWith([ok('sammel-ente', [several])]));
    expect(catalogManager.getCard('lego-minecraft-3', cid('12'))?.name).toBeNull();
    expect(chosenReference('lego-minecraft-3', cid('12'))).toBeNull();
    // A single card without a name still gives its picture.
    await runCheck(depsWith([ok('sammel-ente', [nameless])]));
    expect(chosenReference('lego-minecraft-3', cid('12'))).toBe('https://ente/x.jpg');
  });

  test('a failing prune of old alert rows is logged and the run goes on', async () => {
    const prune = spyOn(runManager, 'pruneAlerts').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: prune');
    });
    const log = spyOn(logger, 'log');
    try {
      const s = await runCheck(depsWith([ok('blue-ocean', [blue12])]));
      expect(s.error).toBeUndefined();
      expect(s.notified).toBe(1);
      expect(
        log.mock.calls.some((c: unknown[]) =>
          String(c[1]).includes('pruning old admin alert rows failed')
        )
      ).toBe(true);
    } finally {
      prune.mockRestore();
      log.mockRestore();
    }
  });

  const ente12: Listing = {
    ...blue12,
    shop: 'sammel-ente',
    url: 'https://shop-sammel-ente.de/12',
    cardName: 'C',
    imageUrl: 'https://ente/12.jpg',
  };

  test('a listing nobody wants is not compared, and is once a user adds its card', async () => {
    const blue13: Listing = {
      ...blue12,
      url: 'https://www.blue-ocean.de/p/13',
      cardIds: [cid('13')],
      imageUrl: 'https://img/13.jpg',
    };
    const ente13: Listing = {
      ...ente12,
      url: 'https://shop-sammel-ente.de/13',
      cardIds: [cid('13')],
      imageUrl: 'https://ente/13.jpg',
    };
    const shops = () => [ok('sammel-ente', [ente12, ente13]), ok('blue-ocean', [blue12, blue13])];
    await runCheck(depsWith(shops()));
    expect(embedded).not.toContain('https://img/13.jpg');
    expect(listingManager.getByUrl(blue13.url)!.matchStatus).toBe('pending');
    userManager.addToList('u1', 'lego-minecraft-3', '13');
    await runCheck(depsWith(shops()));
    expect(embedded).toContain('https://img/13.jpg');
    expect(listingManager.getByUrl(blue13.url)!.matchStatus).toBe('confirmed');
  });

  test('a listing without a picture is judged once, not on every run', async () => {
    const setMatch = spyOn(listingManager, 'setMatch');
    try {
      const shops = () => [
        ok('sammel-ente', [ente12]),
        ok('blue-ocean', [{ ...blue12, imageUrl: null }]),
      ];
      await runCheck(depsWith(shops()));
      expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('unconfirmed');
      const calls = setMatch.mock.calls.length;
      await runCheck(depsWith(shops()));
      expect(setMatch.mock.calls.length).toBe(calls);
    } finally {
      setMatch.mockRestore();
    }
  });

  test('a picture that could not be loaded is retried once a day, not every run', async () => {
    let attempts = 0;
    const flaky: ImageEmbedder = {
      model: 'm',
      embed: async (url) => {
        if (url === blue12.imageUrl) {
          attempts++;
          throw new ImageUnavailableError('HTTP 503');
        }
        return new Float32Array([1, 0]);
      },
    };
    const shops = () => [ok('sammel-ente', [ente12]), ok('blue-ocean', [blue12])];
    await runCheck(depsWith(shops(), { embedder: flaky }));
    expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('image_unavailable');
    await runCheck(depsWith(shops(), { embedder: flaky }));
    expect(attempts).toBe(1);
    clock += IMAGE_RETRY_MS;
    await runCheck(depsWith(shops(), { embedder: flaky }));
    expect(attempts).toBe(2);
  });

  test('a legacy image_unavailable row without a check time is retried at once', async () => {
    const shops = () => [ok('sammel-ente', [ente12]), ok('blue-ocean', [blue12])];
    await runCheck(depsWith(shops(), { embedder: null }));
    const row = listingManager.getByUrl(blue12.url)!;
    db.update(listings)
      .set({ matchStatus: 'image_unavailable', matchCheckedAt: null })
      .where(eq(listings.id, row.id))
      .run();
    await runCheck(depsWith(shops()));
    expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('confirmed');
  });

  test('matches new listing images once and stores the result', async () => {
    await runCheck(
      depsWith([
        ok('sammel-ente', [
          {
            ...blue12,
            shop: 'sammel-ente',
            url: 'https://e/12',
            cardName: 'C',
            imageUrl: 'https://ente/12.jpg',
          },
        ]),
        ok('blue-ocean', [blue12]),
      ])
    );
    const l = listingManager.getByUrl(blue12.url)!;
    expect(l.matchStatus).toBe('confirmed');
    expect(l.similarity).toBeCloseTo(1);
    const before = embedded.length;
    await runCheck(depsWith([ok('blue-ocean', [blue12])]));
    expect(embedded.length).toBe(before);
  });

  test('reports skipped counts and shop listing counts', async () => {
    const s = await runCheck(
      depsWith([
        ok('blue-ocean', [blue12]),
        ok('ebay', [], { skippedNoId: 4, skippedExcluded: 3, skippedInvalid: 2 }),
        ok('sammel-ente', [], { skippedNoId: 0 }),
      ])
    );
    expect(s.shops['blue-ocean']).toEqual({ listings: 1 });
    expect(s.shops.ebay).toEqual({
      listings: 0,
      skippedNoId: 4,
      skippedExcluded: 3,
      skippedInvalid: 2,
    });
    expect(s.shops['sammel-ente']).toEqual({ listings: 0 });
  });

  test('a shop whose searches were cut at the page cap alerts once per 24 h', async () => {
    const cut = () =>
      ok('ebay', [], { truncated: ['search "q": 5000 results, only the first 1000 read'] });
    const s = await runCheck(depsWith([cut()]));
    expect(s.shops.ebay).toEqual({ listings: 0, truncated: 1 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('ebay');
    expect(alerts[0]).toContain('5000 results');
    await runCheck(depsWith([cut()]));
    expect(alerts).toHaveLength(1);
    expect(runManager.lastAlertAt('shop-truncated:ebay:lego-minecraft-3')).toBeDefined();
    await runCheck(depsWith([ok('ebay', [], { truncated: [] })]));
    expect(alerts).toHaveLength(1);
  });

  describe('a step failing after the fetch', () => {
    let error: ReturnType<typeof spyOn>;
    beforeEach(() => {
      error = spyOn(logger, 'log');
    });
    afterEach(() => {
      error.mockRestore();
    });

    test("storing one shop failing is that shop's error; the other shops still run", async () => {
      const upsert = spyOn(listingManager, 'upsertFromRun');
      upsert.mockImplementationOnce(() => {
        throw new Error('disk I/O error');
      });
      try {
        const s = await runCheck(depsWith([ok('sammel-ente', []), ok('blue-ocean', [blue12])]));
        expect(s.shops['sammel-ente']!.error).toContain('disk I/O error');
        expect(s.shops['blue-ocean']).toEqual({ listings: 1 });
        expect(s.error).toBeUndefined();
        expect(alerts.some((a) => a.includes('sammel-ente') && a.includes('disk I/O error'))).toBe(
          true
        );
      } finally {
        upsert.mockRestore();
      }
    });

    test('a failing sender records a failed run, alerts once a day and logs the stack', async () => {
      const throwing: NotificationSender = {
        send: async () => {
          throw new Error('gateway gone');
        },
      };
      const s = await runCheck(depsWith([ok('blue-ocean', [blue12])], { sender: throwing }));
      expect(s.error).toBe('gateway gone');
      expect(runManager.last()).toEqual(s);
      expect(alerts).toEqual(['Check run failed: gateway gone']);
      const logged = error.mock.calls.find((c: unknown[]) =>
        String(c[1]).includes('check run failed')
      );
      expect(logged?.[2]).toHaveProperty('stack');
      await runCheck(depsWith([ok('blue-ocean', [blue12])], { sender: throwing }));
      expect(alerts).toHaveLength(1);
    });

    test('one listing failing to match (a cache write) does not stop the others (R8)', async () => {
      userManager.setList('u1', 'lego-minecraft-3', '12, 13');
      const blue13: Listing = {
        ...blue12,
        url: 'https://www.blue-ocean.de/p/13',
        cardIds: [cid('13')],
        imageUrl: 'https://img/13.jpg',
      };
      const ente13: Listing = {
        ...ente12,
        url: 'https://shop-sammel-ente.de/13',
        cardIds: [cid('13')],
        imageUrl: 'https://ente/13.jpg',
      };
      const broken: ImageEmbedder = {
        model: 'm',
        embed: async (url) => {
          if (url === blue12.imageUrl) throw new Error('SQLITE_BUSY: database is locked');
          return new Float32Array([1, 0]);
        },
      };
      const s = await runCheck(
        depsWith([ok('sammel-ente', [ente12, ente13]), ok('blue-ocean', [blue12, blue13])], {
          embedder: broken,
        })
      );
      expect(s.error).toBeUndefined();
      // The failed one stays pending (retried next run, notified as not checked yet).
      expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('pending');
      expect(listingManager.getByUrl(blue13.url)!.matchStatus).toBe('confirmed');
      expect(s.notified).toBe(1);
      expect(alerts.filter((a) => a.includes('SQLITE_BUSY'))).toHaveLength(1);
      expect(alerts.find((a) => a.includes('SQLITE_BUSY'))).toContain(blue12.url);
    });
  });

  test('a shop returning less than half of its recent peak count alerts', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...blue12,
      url: `https://www.blue-ocean.de/p/${i + 1}`,
    }));
    await runCheck(depsWith([ok('blue-ocean', many)]));
    await runCheck(depsWith([failing('blue-ocean', new Error('down'))]));
    alerts = [];
    await runCheck(depsWith([ok('blue-ocean', many.slice(0, 5))]));
    expect(alerts).toEqual([]);
    await runCheck(depsWith([ok('blue-ocean', many.slice(0, 2))]));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('2 card listings, down from 10 at most in the last 3 days —');
  });

  test('formatWindow prints whole days plainly and never a long decimal', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(formatWindow(3 * day)).toBe('3 days');
    expect(formatWindow(day)).toBe('1 day');
    expect(formatWindow(2.5 * day)).toBe('2.5 days');
    expect(formatWindow(10 * day) + formatWindow(day / 3)).toBe('10 days8 hours');
    expect(formatWindow((10 / 3) * day)).toBe('3.3 days');
    expect(formatWindow(60 * 60 * 1000)).toBe('1 hour');
    expect(formatWindow(3 * 24 * 60 * 60 * 1000)).toBe('3 days');
  });

  test('a lasting drop keeps alerting once a day instead of becoming the new normal', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...blue12,
      url: `https://www.blue-ocean.de/p/${i + 1}`,
    }));
    await runCheck(depsWith([ok('blue-ocean', many)]));
    const few = () => ok('blue-ocean', many.slice(0, 2));
    await runCheck(depsWith([few()]));
    expect(alerts).toHaveLength(1);
    await runCheck(depsWith([few()]));
    expect(alerts).toHaveLength(1);
    clock += 25 * 60 * 60 * 1000;
    await runCheck(depsWith([few()]));
    expect(alerts).toHaveLength(2);
  });

  test('a lasting drop at the hourly cadence alerts again after the 24 h throttle', async () => {
    const hour = 60 * 60 * 1000;
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...blue12,
      url: `https://www.blue-ocean.de/p/${i + 1}`,
    }));
    await runCheck(depsWith([ok('blue-ocean', many)]));
    const alertHours: number[] = [];
    for (let h = 1; h <= 30; h += 1) {
      clock += hour;
      const before = alerts.length;
      await runCheck(depsWith([ok('blue-ocean', many.slice(0, 2))]));
      if (alerts.length > before) alertHours.push(h);
    }
    // First low run alerts; the throttle holds for 24 h; the peak (10) is still inside the
    // 3-day window although far more than 5 low runs have happened since.
    expect(alertHours).toEqual([1, 25]);
  });

  test('an unreadable baseline skips only the drop check, with a log', async () => {
    const peak = spyOn(runManager, 'shopPeakListings').mockImplementation(() => {
      throw new Error('db locked');
    });
    const error = spyOn(logger, 'log');
    try {
      const soldOut = [{ ...blue12, available: false }];
      const s = await runCheck(depsWith([ok('blue-ocean', soldOut)]));
      expect(s.shops['blue-ocean']).toEqual({ listings: 1 });
      expect(listingManager.getByUrl(blue12.url)).toBeDefined();
      expect(error).toHaveBeenCalled();
      expect(error.mock.calls.flat().join(' ')).toContain('drop check skipped');
      // The all-unavailable alert is independent of the baseline and still fires in that run.
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain('all 1');
    } finally {
      peak.mockRestore();
      error.mockRestore();
    }
  });

  test('a failing alertAdmin does not fail the run', async () => {
    const s = await runCheck(
      depsWith([failing('blue-ocean', new Error('down'))], {
        alertAdmin: async () => {
          throw new Error('discord down');
        },
      })
    );
    expect(s.shops['blue-ocean']!.error).toContain('down');
  });

  test('a failed admin alert gives the 24 h slot back so the next run alerts again', async () => {
    let fail = true;
    const alertAdmin = async (text: string) => {
      if (fail) throw new Error('dms closed');
      alerts.push(text);
    };
    const down = () => failing('blue-ocean', new Error('down'));
    await runCheck(depsWith([down()], { alertAdmin }));
    expect(alerts).toHaveLength(0);
    fail = false;
    await runCheck(depsWith([down()], { alertAdmin }));
    expect(alerts).toHaveLength(1);
    await runCheck(depsWith([down()], { alertAdmin }));
    expect(alerts).toHaveLength(1);
  });

  test('listings of a shop that keeps failing are not notified once stale', async () => {
    sender.failFor('u1');
    await runCheck(depsWith([ok('blue-ocean', [blue12])]));
    const down = () => failing('blue-ocean', new Error('down'));
    // Seen one and two intervals ago: still retried.
    expect((await runCheck(depsWith([down()]))).dmFailures).toBe(1);
    expect((await runCheck(depsWith([down()]))).dmFailures).toBe(1);
    sender.failFor(null);
    // Last seen more than two intervals ago: stale, not notified.
    const stale = await runCheck(depsWith([down()]));
    expect(stale.notified).toBe(0);
    expect(stale.dmFailures).toBe(0);
  });

  test('an eBay listing missing for three intervals (within the 24 h grace) is not notified until seen again', async () => {
    const ebay12: Listing = {
      ...blue12,
      shop: 'ebay',
      url: 'https://www.ebay.de/itm/1',
      format: 'fixed_price',
    };
    const other: Listing = { ...ebay12, url: 'https://www.ebay.de/itm/2', cardIds: [cid('99')] };
    userManager.clearList('u1', 'lego-minecraft-3');
    userManager.setList('u0', 'lego-minecraft-3', '99');
    await runCheck(depsWith([ok('ebay', [ebay12, other])]));
    for (let i = 0; i < 3; i++) await runCheck(depsWith([ok('ebay', [other])]));
    // Still available (grace), but last seen three intervals ago: stale.
    expect(listingManager.getByUrl(ebay12.url)!.available).toBe(true);
    userManager.setList('u1', 'lego-minecraft-3', '12');
    expect((await runCheck(depsWith([ok('ebay', [other])]))).notified).toBe(0);
    expect((await runCheck(depsWith([ok('ebay', [ebay12, other])]))).notified).toBe(1);
    expect((await runCheck(depsWith([ok('ebay', [ebay12, other])]))).notified).toBe(0);
  });

  test('a shop whose card listings are all unavailable alerts the admin but still updates', async () => {
    const soldOut = [
      { ...blue12, available: false },
      { ...blue12, url: 'https://www.blue-ocean.de/p/13', cardIds: [cid('13')], available: false },
    ];
    await runCheck(depsWith([ok('blue-ocean', [blue12])]));
    const s = await runCheck(depsWith([ok('blue-ocean', soldOut)]));
    expect(s.shops['blue-ocean']).toEqual({ listings: 2 });
    expect(listingManager.getByUrl(blue12.url)!.available).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('blue-ocean');
    expect(alerts[0]).toContain('all 2');
    await runCheck(depsWith([ok('blue-ocean', soldOut)]));
    expect(alerts).toHaveLength(1);
    expect(
      runManager.lastAlertAt('shop-all-unavailable:blue-ocean:lego-minecraft-3')
    ).toBeDefined();
  });

  test('no alert when some listings are available or the shop returned none', async () => {
    await runCheck(
      depsWith([ok('blue-ocean', [blue12, { ...blue12, url: 'https://x/2', available: false }])])
    );
    await runCheck(depsWith([ok('ebay', [])]));
    expect(alerts).toHaveLength(0);
  });

  describe('image matching unavailable', () => {
    let warn: ReturnType<typeof spyOn>;
    beforeEach(() => {
      warn = spyOn(logger, 'warn');
    });
    afterEach(() => {
      warn.mockRestore();
    });

    const reference = (n: number): Listing => ({
      ...blue12,
      shop: 'sammel-ente',
      url: `https://shop-sammel-ente.de/${n}`,
      cardIds: [cid(String(n))],
      cardName: `C${n}`,
      imageUrl: `https://shop-sammel-ente.de/${n}.jpg`,
    });
    const candidate = (n: number): Listing => ({
      ...blue12,
      url: `https://www.blue-ocean.de/p/${n}`,
      cardIds: [cid(String(n))],
      imageUrl: `https://www.blue-ocean.de/${n}.jpg`,
    });

    test('without a model, one warning per run instead of one per listing', async () => {
      userManager.setList('u1', 'lego-minecraft-3', '12, 13, 14');
      const shops = () => [
        ok('sammel-ente', [12, 13, 14].map(reference)),
        ok('blue-ocean', [12, 13, 14].map(candidate)),
      ];
      await runCheck(depsWith(shops(), { embedder: null }));
      const matchWarnings = () =>
        warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('image match'));
      expect(matchWarnings()).toHaveLength(1);
      // The three sammel-ente listings are compared too.
      expect(String(matchWarnings()[0]![0])).toContain('(model_unavailable) for 6 listings');
      expect(listingManager.getByUrl(candidate(13).url)!.matchStatus).toBe('model_unavailable');
    });

    test('a failing model also warns once per run', async () => {
      userManager.setList('u1', 'lego-minecraft-3', '12, 13');
      const broken: ImageEmbedder = {
        model: 'broken',
        embed: async () => {
          throw new ModelError('broken: onnx runtime missing');
        },
      };
      await runCheck(
        depsWith(
          [ok('sammel-ente', [12, 13].map(reference)), ok('blue-ocean', [12, 13].map(candidate))],
          { embedder: broken }
        )
      );
      const matchWarnings = warn.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes('image match')
      );
      expect(matchWarnings).toHaveLength(1);
      expect(String(matchWarnings[0]![0])).toContain('onnx runtime missing');
    });
  });
  describe('picture identification', () => {
    /** A unit vector at `deg` degrees: the cosine of two of them is cos(Δdeg). */
    const at = (deg: number) => {
      const rad = (deg * Math.PI) / 180;
      return new Float32Array([Math.cos(rad), Math.sin(rad)]);
    };
    // References: 12 at 0°, 45 at 60°, puzzle card 160 at -60°.
    const angles: Record<string, number> = {
      'https://ente/12.jpg': 0,
      'https://ente/45.jpg': 60,
      'https://ente/160.jpg': -60,
      'https://ente/77.jpg': 150,
    };
    const angled: ImageEmbedder = {
      model: 'angled',
      embed: async (url) => {
        embedded.push(url);
        const deg = angles[url];
        if (deg === undefined) throw new Error(`test: no angle for ${url}`);
        return at(deg);
      },
    };
    const reference = (id: string, name: string): Listing => ({
      ...blue12,
      shop: 'sammel-ente',
      url: `https://shop-sammel-ente.de/${id}`,
      cardIds: [cid(id)],
      cardName: name,
      imageUrl: `https://ente/${id}.jpg`,
      // Sold out, so only the listing under test can notify.
      available: false,
    });
    const references = [
      reference('12', 'Squid'),
      reference('45', 'Steve'),
      reference('77', 'Efe'),
      reference('160', 'Puzzlekarte Oberwelt 7'),
    ];
    /** blue12 with its picture at `deg`. */
    const blueAt = (deg: number): Listing => {
      const imageUrl = `https://img/12-${deg}.jpg`;
      angles[imageUrl] = deg;
      return { ...blue12, imageUrl };
    };
    const candidateAt = (deg: number): Listing => {
      const imageUrl = `https://i.ebayimg.com/c-${deg}.jpg`;
      angles[imageUrl] = deg;
      return {
        ...blue12,
        shop: 'ebay',
        url: `https://www.ebay.de/itm/9${deg + 100}`,
        title: 'LEGO Minecraft On Fire Serie 3 Steve',
        cardIds: [],
        imageUrl,
        format: 'fixed_price',
        idSource: 'picture',
      };
    };
    const run = (shops: ShopAdapter[], over: Partial<RunDeps> = {}) =>
      runCheck(depsWith(shops, { embedder: angled, ...over }));
    beforeEach(() => {
      // A catalog every card of which has a reference: the set is complete (R1).
      catalogManager.applyImport({
        collection: 'lego-minecraft-3',
        ids: ids('12', '45', '77', '160'),
      });
      // #160 is a puzzle card, as the laststicker sync marks it.
      setCatalogCards('lego-minecraft-3', [{ cardId: cid('160'), puzzle: true }]);
    });
    /** The admin alerts but the one for the sold-out references. */
    const notes = () =>
      alerts.filter(
        (a) => !a.startsWith('Shop sammel-ente (LEGO Minecraft Serie 3 "On Fire"): all')
      );

    test('a sammel-ente "Puzzlekarte" name no longer marks a puzzle card', async () => {
      setCatalogCards('lego-minecraft-3', [{ cardId: cid('160'), puzzle: false }]);
      await run([ok('sammel-ente', references)]);
      expect(catalogManager.getCard('lego-minecraft-3', cid('160'))?.puzzle).toBe(false);
    });

    test('rule 1: a picture deciding the title card confirms it and notifies', async () => {
      const r = await run([ok('sammel-ente', references), ok('blue-ocean', [blueAt(5)])]);
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        matchStatus: 'confirmed',
        pictureCardId: '12',
      });
      expect(r.notified).toBe(1);
      expect(notes()).toEqual([]);
    });

    test('rule 2: a mismatch is held back and the admin gets one note per listing', async () => {
      userManager.setList('u2', 'lego-minecraft-3', '45');
      const shops = () => [ok('sammel-ente', references), ok('blue-ocean', [blueAt(60)])];
      const r = await run(shops());
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        cardIds: ['12'],
        matchStatus: 'mismatch',
        pictureCardId: '45',
      });
      expect(r.notified).toBe(0);
      expect(notes()).toHaveLength(1);
      expect(notes()[0]).toContain('#12');
      expect(notes()[0]).toContain('#45');
      expect(notes()[0]).toContain(blue12.url);
      expect(notes()[0]).toContain('/admin map');
      await run(shops());
      clock += 25 * 60 * 60 * 1000;
      expect((await run(shops())).notified).toBe(0);
      expect(notes()).toHaveLength(1);
    });

    test('rule 2: a rescrape with a changed picture compares again', async () => {
      await run([ok('sammel-ente', references), ok('blue-ocean', [blueAt(60)])]);
      expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('mismatch');
      const r = await run([ok('sammel-ente', references), ok('blue-ocean', [blueAt(3)])]);
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        matchStatus: 'confirmed',
        pictureCardId: '12',
      });
      expect(r.notified).toBe(1);
    });

    test('rule 2: a rescrape with a changed title compares again', async () => {
      const listing = blueAt(60);
      await run([ok('sammel-ente', references), ok('blue-ocean', [listing])]);
      const before = embedded.length;
      await run([
        ok('sammel-ente', references),
        ok('blue-ocean', [{ ...listing, title: 'Sticker Card 12 (neu)' }]),
      ]);
      expect(embedded.length).toBeGreaterThan(before);
      expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('mismatch');
    });

    describe('the re-match after the reference switch', () => {
      const DAY_AND_MORE = 25 * 60 * 60 * 1000;
      const mismatchNotes = () => notes().filter((a) => a.startsWith('Picture mismatch'));
      const summaries = () =>
        notes().filter((a) => a.startsWith('Re-match against new reference pictures'));
      /** What migration 0008 does to the stored listing, with `from` as its old status. */
      const resetAsMigration = (from: LegacyMatchStatus) =>
        db
          .update(listings)
          .set({
            rematchFrom: from,
            matchStatus: 'pending',
            similarity: null,
            matchCheckedAt: null,
            pictureCardId: null,
          })
          .where(eq(listings.url, blue12.url))
          .run();
      const shopsAt = (deg: number) => [
        ok('sammel-ente', references),
        ok('blue-ocean', [blueAt(deg)]),
      ];

      test('the re-match sends one summary instead of a note per mismatch', async () => {
        await run(shopsAt(60));
        expect(mismatchNotes()).toHaveLength(1);
        resetAsMigration('confirmed');
        clock += DAY_AND_MORE;
        const r = await run(shopsAt(60));
        expect(listingManager.getByUrl(blue12.url)).toMatchObject({
          matchStatus: 'mismatch',
          rematchFrom: null,
        });
        expect(mismatchNotes()).toHaveLength(1);
        expect(summaries()).toHaveLength(1);
        const line = `#12 blue-ocean confirmed→mismatch (picture #45) ${blue12.url}`;
        expect(summaries()[0]).toContain('compared 1 listing(s) again, 1 changed.');
        expect(summaries()[0]).toContain(`Mismatches, not sent to users: ${line};`);
        expect(r.rematch).toEqual({ compared: 1, changed: 1, changes: [line] });
        clock += DAY_AND_MORE;
        expect((await run(shopsAt(60))).rematch).toBeUndefined();
        expect(summaries()).toHaveLength(1);
        expect(mismatchNotes()).toHaveLength(1);
      });

      test('a summary that fails leaves the new mismatch its own note', async () => {
        await run(shopsAt(60));
        resetAsMigration('confirmed');
        clock += DAY_AND_MORE;
        const alertAdmin = async (text: string) => {
          if (text.startsWith('Re-match against new reference pictures'))
            throw new Error('DM failed');
          alerts.push(text);
        };
        await run(shopsAt(60), { alertAdmin });
        expect(summaries()).toEqual([]);
        expect(mismatchNotes()).toHaveLength(2);
      });

      test('a listing that stays a mismatch is named in the summary, not in a new note', async () => {
        await run(shopsAt(60));
        expect(mismatchNotes()).toHaveLength(1);
        resetAsMigration('mismatch');
        clock += DAY_AND_MORE;
        const r = await run(shopsAt(60));
        expect(r.rematch).toEqual({ compared: 1, changed: 0, changes: [] });
        expect(mismatchNotes()).toHaveLength(1);
        // The old picture card and whether its note went out are unknown: the summary names it.
        expect(summaries()).toHaveLength(1);
        expect(summaries()[0]).toContain(
          `#12 blue-ocean mismatch→mismatch (picture #45) ${blue12.url}`
        );
      });

      test('an old mismatch that cannot be compared yet is not notified', async () => {
        userManager.setList('u2', 'lego-minecraft-3', '12');
        await run(shopsAt(60));
        resetAsMigration('mismatch');
        const r = await run(shopsAt(60), { embedder: null });
        expect(listingManager.getByUrl(blue12.url)).toMatchObject({
          matchStatus: 'model_unavailable',
          rematchFrom: 'mismatch',
        });
        expect(r.notified).toBe(0);
      });

      test('an old mismatch decided right now reaches its users', async () => {
        await run(shopsAt(60));
        resetAsMigration('mismatch');
        const r = await run(shopsAt(5));
        expect(listingManager.getByUrl(blue12.url)).toMatchObject({
          matchStatus: 'confirmed',
          rematchFrom: null,
        });
        expect(summaries()[0]).toContain('mismatch→confirmed');
        expect(r.notified).toBe(1);
      });

      test('a failing summary step is logged and alerted; the users still get their DMs', async () => {
        await run(shopsAt(60));
        resetAsMigration('confirmed');
        clock += DAY_AND_MORE;
        const spy = spyOn(listingManager, 'markMismatchesNoted').mockImplementation(() => {
          throw new Error('db locked');
        });
        try {
          await run(shopsAt(60));
          expect(alerts.some((a) => a.startsWith('The re-match summary failed: db locked'))).toBe(
            true
          );
          // The run went on: the mismatch, not marked noted, gets its own note.
          expect(mismatchNotes()).toHaveLength(2);
        } finally {
          spy.mockRestore();
        }
      });

      test('a title naming no card is named "no card" in the summary', async () => {
        const listing = candidateAt(30);
        await run([ok('sammel-ente', references), ok('ebay', [listing])]);
        expect(listingManager.getByUrl(listing.url)).toMatchObject({
          matchStatus: 'unconfirmed',
          cardIds: [],
        });
        db.update(listings)
          .set({ rematchFrom: 'confirmed', matchStatus: 'pending', matchCheckedAt: null })
          .where(eq(listings.url, listing.url))
          .run();
        const r = await run([ok('sammel-ente', references), ok('ebay', [listing])]);
        expect(r.rematch?.changes).toEqual([`no card ebay confirmed→unconfirmed ${listing.url}`]);
      });

      test('a re-match that finds no reference is not counted and stays held back', async () => {
        await run(shopsAt(60));
        resetAsMigration('mismatch');
        // The title card loses its reference.
        db.update(cards)
          .set({ shopImageUrl: null })
          .where(eq(cards.cardId, cid('12')))
          .run();
        const r = await run([ok('blue-ocean', [blueAt(60)])]);
        expect(listingManager.getByUrl(blue12.url)).toMatchObject({
          matchStatus: 'no_reference',
          rematchFrom: 'mismatch',
        });
        expect(r.rematch).toBeUndefined();
        expect(r.notified).toBe(0);
      });

      test('an unchanged re-match sends no summary; reference counts as confirmed', async () => {
        await run(shopsAt(5));
        resetAsMigration('reference');
        const r = await run(shopsAt(5));
        expect(listingManager.getByUrl(blue12.url)).toMatchObject({
          matchStatus: 'confirmed',
          rematchFrom: null,
        });
        expect(r.rematch).toEqual({ compared: 1, changed: 0, changes: [] });
        expect(summaries()).toEqual([]);
      });

      test('a listing that cannot be compared keeps rematchFrom', async () => {
        await run(shopsAt(5));
        resetAsMigration('confirmed');
        const r = await run(shopsAt(5), { embedder: null });
        expect(listingManager.getByUrl(blue12.url)).toMatchObject({
          matchStatus: 'model_unavailable',
          rematchFrom: 'confirmed',
        });
        expect(r.rematch).toBeUndefined();
      });

      test('an available listing notified before the reset is not notified again', async () => {
        expect((await run(shopsAt(5))).notified).toBe(1);
        resetAsMigration('confirmed');
        expect((await run(shopsAt(5))).notified).toBe(0);
        expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('confirmed');
      });
    });

    test('known twins: a #59 picture closest to XXL1 is no mismatch, and is sent', async () => {
      catalogManager.applyImport({
        collection: 'lego-minecraft-3',
        ids: ids('12', '45', '59', '77', '160', 'XXL1'),
      });
      setCatalogCards('lego-minecraft-3', [{ cardId: cid('160'), puzzle: true }]);
      // #59 and XXL1 score 0.82 apart: below TWIN_SIMILARITY, twins only by knownTwins.
      angles['https://ente/59.jpg'] = 80;
      angles['https://ente/XXL1.jpg'] = 115;
      angles['https://img/59-120.jpg'] = 120;
      userManager.setList('u1', 'lego-minecraft-3', '59');
      const listing59: Listing = {
        ...blue12,
        url: 'https://www.blue-ocean.de/p/59',
        cardIds: [cid('59')],
        imageUrl: 'https://img/59-120.jpg',
      };
      const r = await run([
        ok('sammel-ente', [
          ...references,
          reference('59', 'Charged Creeper'),
          reference('XXL1', 'Charged Creeper'),
        ]),
        ok('blue-ocean', [listing59]),
      ]);
      expect(listingManager.getByUrl(listing59.url)!.matchStatus).toBe('unconfirmed');
      expect(r.notified).toBe(1);
    });

    test("rule 3: an undecided picture falls back to today's comparison", async () => {
      const r = await run([ok('sammel-ente', references), ok('blue-ocean', [blueAt(30)])]);
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        matchStatus: 'confirmed',
        similarity: expect.closeTo(Math.cos(Math.PI / 6), 5),
        pictureCardId: null,
      });
      expect(r.notified).toBe(1);
    });

    test('rule 4: a decided eBay candidate gets the picture card and notifies its users', async () => {
      userManager.setList('u2', 'lego-minecraft-3', '45');
      const candidate = candidateAt(58);
      const r = await run([ok('sammel-ente', references), ok('ebay', [candidate])]);
      expect(listingManager.getByUrl(candidate.url)).toMatchObject({
        cardIds: ['45'],
        idSource: 'picture',
        matchStatus: 'confirmed',
        pictureCardId: '45',
      });
      expect(r.notified).toBe(1);
      // The next scrape keeps the card and does not compare again.
      const before = embedded.length;
      expect((await run([ok('sammel-ente', references), ok('ebay', [candidate])])).notified).toBe(
        0
      );
      expect(embedded.length).toBe(before);
      expect(listingManager.getByUrl(candidate.url)!.cardIds).toEqual([cid('45')]);
    });

    test('rule 4: an undecided candidate is stored without cards and never notified', async () => {
      userManager.setList('u2', 'lego-minecraft-3', '12, 45');
      const candidate = candidateAt(30);
      const r = await run([ok('sammel-ente', references), ok('ebay', [candidate])]);
      expect(listingManager.getByUrl(candidate.url)).toMatchObject({
        cardIds: [],
        matchStatus: 'unconfirmed',
        pictureCardId: null,
      });
      expect(r.notified).toBe(0);
    });

    test('rule 5: a puzzle picture never decides a candidate nor makes a mismatch', async () => {
      userManager.setList('u1', 'lego-minecraft-3', '12, 160');
      const candidate = candidateAt(-60);
      const r = await run([
        ok('sammel-ente', references),
        ok('blue-ocean', [blueAt(-60)]),
        ok('ebay', [candidate]),
      ]);
      expect(listingManager.getByUrl(candidate.url)!.cardIds).toEqual([]);
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        matchStatus: 'unconfirmed',
        pictureCardId: null,
      });
      expect(notes()).toEqual([]);
      // The unconfirmed blue-ocean 12 is still notified, as before.
      expect(r.notified).toBe(1);
    });

    test('an admin-mapped listing is never identified again', async () => {
      await run([ok('sammel-ente', references), ok('blue-ocean', [blueAt(60)])]);
      listingManager.overrideCards(
        blue12.url,
        { collection: 'lego-minecraft-3', ids: [cid('12')] },
        clock
      );
      const before = embedded.length;
      await run([ok('sammel-ente', references), ok('blue-ocean', [blueAt(61)])]);
      expect(embedded.length).toBe(before);
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        matchStatus: 'confirmed',
        manualOverride: true,
        pictureCardId: null,
      });
    });

    test('a placeholder reference is no reference: no_reference, never identified', async () => {
      // sammel-ente shows the empty card mnc3_leer.jpg for LE10 and LE11 (2026-11-18).
      const leer = 'https://ente/mnc3_leer.jpg';
      angles[leer] = 120;
      const placeholder = (id: string, name: string): Listing => ({
        ...reference(id, name),
        imageUrl: leer,
      });
      catalogManager.applyImport({
        collection: 'lego-minecraft-3',
        ids: ids('12', '45', '77', '160', 'LE10', 'LE11'),
      });
      userManager.setList('u1', 'lego-minecraft-3', '12, LE10');
      const blueLE10: Listing = {
        ...blue12,
        url: 'https://www.blue-ocean.de/p/le10',
        cardIds: [cid('LE10')],
        imageUrl: 'https://img/le10.jpg',
      };
      angles['https://img/le10.jpg'] = 120;
      // Undecided among the real references (45 and 77 both at 0.707).
      const candidate = candidateAt(105);
      await run([
        ok('sammel-ente', [
          ...references,
          placeholder('LE10', 'Exploding Creeper'),
          placeholder('LE11', 'Iron Golem'),
        ]),
        ok('blue-ocean', [blueLE10]),
        ok('ebay', [candidate]),
      ]);
      expect(listingManager.getByUrl(blueLE10.url)!.matchStatus).toBe('no_reference');
      expect(listingManager.getByUrl(candidate.url)).toMatchObject({
        cardIds: [],
        pictureCardId: null,
      });
      expect(embedded).not.toContain(leer);
    });

    test('references are embedded only when a listing needs a match', async () => {
      await run([ok('sammel-ente', references)]);
      expect(embedded).toEqual([]);
      await run([ok('sammel-ente', references), ok('blue-ocean', [blueAt(5)])]);
      expect(embedded.filter((u) => u.startsWith('https://ente/')).sort()).toEqual(
        // The title card's own reference, then every reference once for the identification.
        [
          'https://ente/12.jpg',
          'https://ente/12.jpg',
          'https://ente/160.jpg',
          'https://ente/45.jpg',
          'https://ente/77.jpg',
        ]
      );
    });

    test('a reference picture that cannot be loaded is skipped with one warning per run', async () => {
      const warn = spyOn(logger, 'warn');
      try {
        const flaky: ImageEmbedder = {
          model: 'angled',
          embed: async (url) => {
            if (url === 'https://ente/45.jpg') throw new ImageUnavailableError('HTTP 404');
            return angled.embed(url);
          },
        };
        const r = await runCheck(
          depsWith([ok('sammel-ente', references), ok('blue-ocean', [blueAt(5)])], {
            embedder: flaky,
          })
        );
        expect(r.error).toBeUndefined();
        // Rule 1 still confirms the title card.
        expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('confirmed');
        const lines = warn.mock.calls.map((c: unknown[]) => String(c[0]));
        expect(lines.filter((l) => l.includes('reference picture'))).toHaveLength(1);
        // R3: one throttled admin alert naming the count, the card and the reason.
        const note = notes().filter((a) => a.includes('reference picture'));
        expect(note).toHaveLength(1);
        expect(note[0]).toContain('1 reference picture');
        expect(note[0]).toContain('#45');
        expect(note[0]).toContain('HTTP 404');
      } finally {
        warn.mockRestore();
      }
    });

    test('the reference-unavailable alert: text, count, ids, and once a day (I1)', async () => {
      const broken: ImageEmbedder = {
        model: 'angled',
        embed: async (url) => {
          if (url === 'https://ente/45.jpg') throw new ImageUnavailableError('HTTP 404');
          if (url === 'https://ente/77.jpg') throw new ImageUnavailableError('HTTP 410');
          return angled.embed(url);
        },
      };
      const shops = (deg: number) => [
        ok('sammel-ente', references),
        ok('blue-ocean', [blueAt(deg)]),
      ];
      await run(shops(5), { embedder: broken });
      const sent = () => notes().filter((a) => a.includes('could not be loaded'));
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toStartWith(
        '2 reference picture(s) of LEGO Minecraft Serie 3 "On Fire" could not be loaded this run'
      );
      expect(
        db
          .select()
          .from(adminAlerts)
          .all()
          .map((r) => r.key)
      ).toContain('reference-unavailable:lego-minecraft-3');
      expect(sent()[0]).toContain('#45 (image_unavailable: HTTP 404, https://ente/45.jpg)');
      expect(sent()[0]).toContain('#77 (image_unavailable: HTTP 410, https://ente/77.jpg)');
      // A new listing needs the set again the same day: throttled.
      await run(shops(6), { embedder: broken });
      expect(sent()).toHaveLength(1);
      clock += 25 * 60 * 60 * 1000;
      await run(shops(7), { embedder: broken });
      expect(sent()).toHaveLength(2);
    });

    test('a failing mismatch-note step still sends the users their DMs (I2)', async () => {
      const notesStep = spyOn(listingManager, 'pendingMismatchNotes').mockImplementation(() => {
        throw new Error('SQLITE_BUSY: notes');
      });
      try {
        const r = await run([ok('sammel-ente', references), ok('blue-ocean', [blueAt(5)])]);
        expect(r.error).toBeUndefined();
        expect(r.notified).toBe(1);
        expect(notes().filter((a) => a.includes('SQLITE_BUSY: notes'))).toHaveLength(1);
      } finally {
        notesStep.mockRestore();
      }
    });

    test('a listing whose match failed is not notified in that run, but once matched (M1)', async () => {
      let broken = true;
      const flaky: ImageEmbedder = {
        model: 'angled',
        embed: async (url) => {
          if (broken && url === 'https://img/12-5.jpg') throw new Error('SQLITE_BUSY');
          return angled.embed(url);
        },
      };
      const shops = () => [ok('sammel-ente', references), ok('blue-ocean', [blueAt(5)])];
      expect((await run(shops(), { embedder: flaky })).notified).toBe(0);
      expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('pending');
      broken = false;
      expect((await run(shops(), { embedder: flaky })).notified).toBe(1);
      expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('confirmed');
    });

    describe('the reference set must be complete (R1, R2, R13)', () => {
      const flaky45 = (failing: { on: boolean }): ImageEmbedder => ({
        model: 'angled',
        embed: async (url) => {
          if (failing.on && url === 'https://ente/45.jpg') {
            throw new ImageUnavailableError('HTTP 503');
          }
          return angled.embed(url);
        },
      });

      test('a reference failing to load leaves would-be decisions retryable; the next try decides', async () => {
        userManager.setList('u2', 'lego-minecraft-3', '45');
        const failing = { on: true };
        const candidate = candidateAt(58);
        const shops = () => [
          ok('sammel-ente', references),
          ok('blue-ocean', [blueAt(60)]),
          ok('ebay', [candidate]),
        ];
        await run(shops(), { embedder: flaky45(failing) });
        expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('image_unavailable');
        expect(listingManager.getByUrl(candidate.url)).toMatchObject({
          cardIds: [],
          matchStatus: 'image_unavailable',
        });
        expect(notes().filter((a) => a.startsWith('Picture mismatch'))).toEqual([]);
        failing.on = false;
        clock += IMAGE_RETRY_MS;
        await run(shops(), { embedder: flaky45(failing) });
        expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('mismatch');
        expect(listingManager.getByUrl(candidate.url)).toMatchObject({
          cardIds: ['45'],
          matchStatus: 'confirmed',
        });
      });

      test('a catalog card without a usable reference: no picture-only card, no mismatch', async () => {
        catalogManager.applyImport({
          collection: 'lego-minecraft-3',
          ids: ids('12', '45', '77', '99', '160'),
        });
        const candidate = candidateAt(58);
        await run([
          ok('sammel-ente', references),
          ok('blue-ocean', [blueAt(60)]),
          ok('ebay', [candidate]),
        ]);
        expect(listingManager.getByUrl(candidate.url)).toMatchObject({
          cardIds: [],
          matchStatus: 'unconfirmed',
        });
        expect(listingManager.getByUrl(blue12.url)).toMatchObject({
          matchStatus: 'unconfirmed',
          pictureCardId: null,
        });
      });

      test('a failed reference is not loaded again within a day across runs', async () => {
        const failing = { on: true };
        const referenceFailures = new Map<string, number>();
        const loads: string[] = [];
        const counting: ImageEmbedder = {
          model: 'angled',
          embed: async (url) => {
            if (url === 'https://ente/45.jpg') loads.push(url);
            return flaky45(failing).embed(url);
          },
        };
        const shopsWith = (deg: number) => [
          ok('sammel-ente', references),
          ok('blue-ocean', [blueAt(deg)]),
        ];
        await run(shopsWith(5), { embedder: counting, referenceFailures });
        failing.on = false;
        await run(shopsWith(6), { embedder: counting, referenceFailures });
        expect(loads).toHaveLength(1);
        clock += IMAGE_RETRY_MS;
        await run(shopsWith(7), { embedder: counting, referenceFailures });
        expect(loads).toHaveLength(2);
        expect(referenceFailures.size).toBe(0);
      });

      test('the reference catalog is read once per run, not per listing', async () => {
        const spy = spyOn(catalogManager, 'referenceCatalog');
        try {
          await run([
            ok('sammel-ente', references),
            ok('blue-ocean', [blueAt(5)]),
            ok('ebay', [candidateAt(58), candidateAt(30)]),
          ]);
          expect(spy.mock.calls.length).toBe(1);
        } finally {
          spy.mockRestore();
        }
      });

      test('placeholder and shared references are named once per run (R10)', async () => {
        const warn = spyOn(logger, 'warn');
        try {
          catalogManager.applyImport({
            collection: 'lego-minecraft-3',
            ids: ids('12', '45', '77', '160', 'LE10', 'LE11'),
          });
          const leer = (id: string): Listing => ({
            ...reference(id, `C${id}`),
            imageUrl: 'https://ente/mnc3_leer.jpg',
          });
          angles['https://ente/mnc3_leer.jpg'] = 120;
          await run([
            ok('sammel-ente', [...references, leer('LE10'), leer('LE11')]),
            ok('blue-ocean', [blueAt(5)]),
            ok('ebay', [candidateAt(58)]),
          ]);
          const lines = warn.mock.calls
            .map((c: unknown[]) => String(c[0]))
            .filter((l) => l.includes('no usable reference'));
          expect(lines).toHaveLength(1);
          expect(lines[0]).toContain('#LE10 placeholder');
          expect(lines[0]).toContain('#LE11 placeholder');
        } finally {
          warn.mockRestore();
        }
      });
    });

    describe('mismatch notes (R5, R6, R7)', () => {
      const mismatchNotes = () => notes().filter((a) => a.startsWith('Picture mismatch'));

      test('a note that fails to send goes out in a later run, once', async () => {
        let down = true;
        const alertAdmin = async (text: string) => {
          if (down && text.startsWith('Picture mismatch')) throw new Error('DM failed');
          alerts.push(text);
        };
        const shops = () => [ok('sammel-ente', references), ok('blue-ocean', [blueAt(60)])];
        await run(shops(), { alertAdmin });
        expect(mismatchNotes()).toEqual([]);
        down = false;
        await run(shops(), { alertAdmin });
        expect(mismatchNotes()).toHaveLength(1);
        expect(mismatchNotes()[0]).toContain('fix it with /admin map collection:lego-minecraft-3');
        await run(shops(), { alertAdmin });
        expect(mismatchNotes()).toHaveLength(1);
      });

      test('the same mismatch twice is one note; another picture card or a day later is another', async () => {
        const listing = blueAt(60);
        await run([ok('sammel-ente', references), ok('blue-ocean', [listing])]);
        // Compared again (a changed title), same outcome: throttled.
        await run([
          ok('sammel-ente', references),
          ok('blue-ocean', [{ ...listing, title: 'Sticker Card 12 (neu)' }]),
        ]);
        expect(mismatchNotes()).toHaveLength(1);
        // Within 24 h, the picture now shows #77: a new note.
        await run([ok('sammel-ente', references), ok('blue-ocean', [blueAt(150)])]);
        expect(mismatchNotes()).toHaveLength(2);
        expect(mismatchNotes()[1]).toContain('#77');
        // A day later, back to #45: a note again.
        clock += 25 * 60 * 60 * 1000;
        await run([ok('sammel-ente', references), ok('blue-ocean', [blueAt(61)])]);
        expect(mismatchNotes()).toHaveLength(3);
      });

      test('two mismatched listings give two notes', async () => {
        const other: Listing = { ...blueAt(60), url: 'https://www.blue-ocean.de/p/12b' };
        await run([ok('sammel-ente', references), ok('blue-ocean', [blueAt(60), other])]);
        expect(mismatchNotes()).toHaveLength(2);
      });

      test('throttle rows older than the window are pruned once per run', async () => {
        runManager.shouldAlert('mismatch:1:45', clock, 1);
        clock += 3 * 24 * 60 * 60 * 1000;
        await run([ok('sammel-ente', references)]);
        expect(runManager.lastAlertAt('mismatch:1:45')).toBeUndefined();
      });
    });

    test('/admin map after a mismatch notifies exactly once on the next run (T5)', async () => {
      const shops = () => [ok('sammel-ente', references), ok('blue-ocean', [blueAt(60)])];
      expect((await run(shops())).notified).toBe(0);
      listingManager.overrideCards(
        blue12.url,
        { collection: 'lego-minecraft-3', ids: [cid('12')] },
        clock
      );
      expect((await run(shops())).notified).toBe(1);
      expect((await run(shops())).notified).toBe(0);
    });

    test('a changed reference picture compares a mismatch again in the same run (R12)', async () => {
      await run([ok('sammel-ente', references), ok('blue-ocean', [blueAt(60)])]);
      expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('mismatch');
      // sammel-ente's #12 now shows a picture at 58°, like the listing.
      angles['https://ente/12-new.jpg'] = 58;
      const moved = references.map((r) =>
        r.cardIds[0] === '12' ? { ...r, imageUrl: 'https://ente/12-new.jpg' } : r
      );
      await run([ok('sammel-ente', moved), ok('blue-ocean', [blueAt(60)])]);
      expect(listingManager.getByUrl(blue12.url)!.matchStatus).not.toBe('mismatch');
    });

    test('the run summary counts the picture decisions and why others did not count (R9)', async () => {
      const s = await run([
        ok('sammel-ente', references),
        ok('blue-ocean', [blueAt(60)]),
        ok('ebay', [candidateAt(30), candidateAt(-60), candidateAt(58)]),
      ]);
      expect(s.pictures).toEqual({ decided: 2, undecided: 1, puzzle: 1 });
    });
  });
});

describe('rematchText', () => {
  const line = (n: number, to = 'unconfirmed') =>
    `#${n} ebay confirmed→${to} https://www.ebay.de/itm/${'9'.repeat(150)}${n}`;

  test('names the mismatches first, then at most the changes that fit, and how many more', () => {
    const changes = Array.from({ length: 10 }, (_, i) => line(i + 1));
    const { text, named } = rematchText({
      compared: 30,
      changed: 12,
      changes,
      mismatches: [{ id: 7, line: line(99, 'mismatch'), changed: true }],
    });
    expect(
      text.startsWith(
        'Re-match against new reference pictures: compared 30 listing(s) again, 12 changed.'
      )
    ).toBe(true);
    expect(text.indexOf(line(99, 'mismatch'))).toBeLessThan(text.indexOf(line(1)));
    expect(named).toEqual([7]);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toMatch(/… and \d+ more$/);
  });

  test('a mismatch without room keeps its own note', () => {
    const mismatches = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      line: line(i, 'mismatch'),
      changed: true,
    }));
    const { text, named } = rematchText({ compared: 20, changed: 20, changes: [], mismatches });
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThan(20);
    expect(text).toContain(`… and ${20 - named.length} more, each with its own note.`);
    for (const id of named) expect(text).toContain(mismatches[id]!.line);
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  test('the tail counts each change once: a named mismatch is no hidden change', () => {
    const { text } = rematchText({
      compared: 12,
      changed: 12,
      changes: Array.from({ length: 10 }, (_, i) => line(i + 1)),
      mismatches: [{ id: 99, line: line(99, 'mismatch'), changed: true }],
    });
    // 12 changes: 1 named mismatch, up to 10 shown, the rest counted.
    const shown = (text.match(/confirmed→unconfirmed/g) ?? []).length;
    expect(text).toMatch(new RegExp(`… and ${12 - 1 - shown} more`));
  });

  test('changes with no room left are still counted', () => {
    const mismatches = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      line: line(i, 'mismatch'),
      changed: false,
    }));
    const { text, named } = rematchText({
      compared: 23,
      changed: 3,
      changes: [line(101), line(102), line(103)],
      mismatches,
    });
    expect(named.length).toBeLessThan(20);
    expect(text).toContain('… and 3 more change(s).');
  });
});

describe('reportRematch', () => {
  const tally = (n: number) => ({
    compared: n,
    changed: n,
    changes: [],
    mismatches: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      line: `#${i} ebay confirmed→mismatch https://www.ebay.de/itm/${'9'.repeat(200)}${i}`,
      changed: true,
    })),
  });

  test('marks only the mismatches the summary names; the rest keep their notes', async () => {
    const marked: number[][] = [];
    const spy = spyOn(listingManager, 'markMismatchesNoted').mockImplementation((ids) => {
      marked.push([...ids]);
    });
    try {
      const summary = { startedAt: 1, finishedAt: 1, shops: {}, notified: 0, dmFailures: 0 };
      await reportRematch(
        { now: () => 5 } as unknown as RunDeps,
        async () => 'sent',
        summary,
        tally(20)
      );
      expect(marked).toHaveLength(1);
      expect(marked[0]!.length).toBeGreaterThan(0);
      expect(marked[0]!.length).toBeLessThan(20);
    } finally {
      spy.mockRestore();
    }
  });

  test('a failed summary marks nothing', async () => {
    const spy = spyOn(listingManager, 'markMismatchesNoted');
    try {
      const summary = { startedAt: 1, finishedAt: 1, shops: {}, notified: 0, dmFailures: 0 };
      await reportRematch(
        { now: () => 5 } as unknown as RunDeps,
        async () => 'failed',
        summary,
        tally(2)
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
