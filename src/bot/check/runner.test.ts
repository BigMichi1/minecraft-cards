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
import { catalogManager } from '../database/catalogManager';
import { listingManager } from '../database/listingManager';
import { runManager } from '../database/runManager';
import { userManager } from '../database/userManager';
import type { ImageEmbedder } from '../matcher/embedder';
import logger from '../utils/logger';
import { ShopLayoutError, type Listing, type ShopAdapter, type ShopId } from '../shops/types';
import {
  runCheck,
  type NotificationSender,
  type PendingNotifications,
  type RunDeps,
} from './runner';

const blue12: Listing = {
  shop: 'blue-ocean',
  url: 'https://www.blue-ocean.de/p/12',
  title: 'Sticker Card 12',
  cardIds: ['12'],
  cardName: null,
  imageUrl: 'https://img/12.jpg',
  price: { cents: 199, currency: 'EUR' },
  available: true,
  format: 'shop',
  auctionEndsAt: null,
  idConflict: false,
};

let fetchCount = 0;
function ok(id: ShopId, items: Listing[], extra: object = {}): ShopAdapter {
  return {
    id,
    fetchListings: async () => {
      fetchCount++;
      return items;
    },
    ...extra,
  };
}
function failing(id: ShopId, error: Error): ShopAdapter {
  return {
    id,
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
    userManager.setList('u1', '12');
    sender = new FakeSender();
    alerts = [];
    embedded = [];
    clock = 1_000_000;
    fetchCount = 0;
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
    userManager.setList('u2', '12');
    sender.failFor('u1');
    const r = await runCheck(depsWith([ok('blue-ocean', [blue12])]));
    expect(r.notified).toBe(1);
    expect(r.dmFailures).toBe(1);
    sender.failFor(null);
    const again = await runCheck(depsWith([ok('blue-ocean', [blue12])]));
    expect(again.notified).toBe(1);
    expect((await runCheck(depsWith([ok('blue-ocean', [blue12])]))).notified).toBe(0);
  });

  test('no wanted cards means no fetch but the run is recorded', async () => {
    userManager.clearList('u1');
    const s = await runCheck(depsWith([ok('blue-ocean', [blue12])]));
    expect(fetchCount).toBe(0);
    expect(s.shops).toEqual({});
    expect(runManager.last()).toEqual(s);
  });

  test('sammel-ente listings update catalog names and reference images', async () => {
    const ente: Listing = {
      ...blue12,
      shop: 'sammel-ente',
      url: 'https://shop-sammel-ente.de/12',
      cardName: 'Creeper',
      imageUrl: 'https://ente/12.jpg',
    };
    await runCheck(depsWith([ok('sammel-ente', [ente])]));
    const card = catalogManager.getCard('12')!;
    expect(card.name).toBe('Creeper');
    expect(card.referenceImageUrl).toBe('https://ente/12.jpg');
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

  test('reports eBay skippedNoId and shop listing counts', async () => {
    const s = await runCheck(
      depsWith([ok('blue-ocean', [blue12]), ok('ebay', [], { lastSkippedNoId: 4 })])
    );
    expect(s.shops['blue-ocean']).toEqual({ listings: 1 });
    expect(s.shops.ebay).toEqual({ listings: 0, skippedNoId: 4 });
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

  test('a shop whose card listings are all unavailable alerts the admin but still updates', async () => {
    const soldOut = [
      { ...blue12, available: false },
      { ...blue12, url: 'https://www.blue-ocean.de/p/13', cardIds: ['13'], available: false },
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
    expect(runManager.lastAlertAt('shop-all-unavailable:blue-ocean')).not.toBeNull();
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
      cardIds: [String(n)],
      cardName: `C${n}`,
      imageUrl: `https://shop-sammel-ente.de/${n}.jpg`,
    });
    const candidate = (n: number): Listing => ({
      ...blue12,
      url: `https://www.blue-ocean.de/p/${n}`,
      cardIds: [String(n)],
      imageUrl: `https://www.blue-ocean.de/${n}.jpg`,
    });

    test('without a model, one warning per run instead of one per listing', async () => {
      userManager.setList('u1', '12, 13, 14');
      const shops = () => [
        ok('sammel-ente', [12, 13, 14].map(reference)),
        ok('blue-ocean', [12, 13, 14].map(candidate)),
      ];
      await runCheck(depsWith(shops(), { embedder: null }));
      const matchWarnings = () =>
        warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('image match'));
      expect(matchWarnings()).toHaveLength(1);
      expect(String(matchWarnings()[0]![0])).toContain('3 listings');
      expect(listingManager.getByUrl(candidate(13).url)!.matchStatus).toBe('model_unavailable');
    });

    test('a failing model also warns once per run', async () => {
      userManager.setList('u1', '12, 13');
      const broken: ImageEmbedder = {
        model: 'broken',
        embed: async () => {
          throw new Error('onnx runtime missing');
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
});
