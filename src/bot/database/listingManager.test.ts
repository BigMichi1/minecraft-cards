import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
import { eq } from 'drizzle-orm';
import { db, initializeDatabase } from './db';
import {
  cards,
  listingCards,
  listings,
  notifications,
  reports,
  users,
  wantedCards,
} from './schema/index';
import { catalogManager } from './catalogManager';
import { listingManager } from './listingManager';
import { imageFingerprint } from '../matcher/imageFingerprint';
import { userManager } from './userManager';
import type { Listing } from '../shops/types';
import type { LegacyMatchStatus } from '../matcher/matchStatus';
import { cid, ids } from '../../test/cardIds';
import type { CollectionId } from '../collections/ids';

/** A collection outside the registry, to show runs and reads stay inside their collection. */
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

describe('listingManager', () => {
  beforeAll(() => {
    initializeDatabase();
  });

  beforeEach(() => {
    db.delete(notifications).run();
    db.delete(reports).run();
    db.delete(listingCards).run();
    db.delete(listings).run();
    db.delete(wantedCards).run();
    db.delete(users).run();
    db.delete(cards).run();
    catalogManager.seedIfEmpty();
  });

  test('listingsForCards returns every stored listing carrying one of the cards, bundles included', () => {
    const sammel12: Listing = {
      ...blue12,
      shop: 'sammel-ente',
      url: 'https://se/12',
      available: false,
    };
    const bundle: Listing = {
      ...blue12,
      shop: 'ebay',
      url: 'https://www.ebay.de/itm/1',
      cardIds: ids('12', '45'),
    };
    const blue45: Listing = {
      ...blue12,
      url: 'https://www.blue-ocean.de/p/45',
      cardIds: [cid('45')],
    };
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12, blue45], 1000);
    listingManager.upsertFromRun('sammel-ente', 'lego-minecraft-3', [sammel12], 1000);
    listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [bundle], 1000);
    const found = listingManager.listingsForCards('lego-minecraft-3', [cid('12')]);
    expect(found.map((l) => l.url).sort()).toEqual([blue12.url, bundle.url, sammel12.url].sort());
    expect(found.find((l) => l.url === bundle.url)!.cardIds).toEqual(ids('12', '45'));
    expect(listingManager.listingsForCards('lego-minecraft-3', [])).toEqual([]);
  });

  test('markGone false keeps unseen listings available; availableCount counts per shop and collection', () => {
    const blue45: Listing = {
      ...blue12,
      url: 'https://www.blue-ocean.de/p/45',
      cardIds: [cid('45')],
    };
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12, blue45], 1000);
    expect(listingManager.availableCount('blue-ocean', 'lego-minecraft-3')).toBe(2);
    expect(listingManager.availableCount('blue-ocean', 'lego-minecraft-1')).toBe(0);
    expect(listingManager.availableCount('ebay', 'lego-minecraft-3')).toBe(0);
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 2000, {
      markGone: false,
    });
    expect(listingManager.getByUrl(blue45.url)!.available).toBe(true);
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 3000);
    expect(listingManager.getByUrl(blue45.url)!.available).toBe(false);
    expect(listingManager.availableCount('blue-ocean', 'lego-minecraft-3')).toBe(1);
  });

  describe('collections', () => {
    test('a listing is stored in the collection of the run that found it', () => {
      const [stored] = listingManager.upsertFromRun(
        'blue-ocean',
        'lego-minecraft-3',
        [blue12],
        1000
      );
      expect(stored!.collection).toBe('lego-minecraft-3');
      expect(listingManager.getByUrl(blue12.url)!.collection).toBe('lego-minecraft-3');
    });

    test('a run marks unavailable only the listings of its own shop and collection', () => {
      listingManager.upsertFromRun('blue-ocean', OTHER, [blue12], 1000);
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [], 2000);
      expect(listingManager.getByUrl(blue12.url)!.available).toBe(true);
      listingManager.upsertFromRun('blue-ocean', OTHER, [], 3000);
      expect(listingManager.getByUrl(blue12.url)!.available).toBe(false);
    });

    test('the warning about another collection clips shop-controlled URLs', () => {
      const long = { ...blue12, url: `https://www.blue-ocean.de/p/${'x'.repeat(400)}` };
      listingManager.upsertFromRun('blue-ocean', OTHER, [long], 1000);
      const warn = spyOn(logger, 'warn');
      try {
        listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [long], 2000);
        const [line] = warn.mock.calls.map((c: unknown[]) => String(c[0]));
        expect(line).not.toContain(long.url);
        expect(line!.length).toBeLessThan(400);
      } finally {
        warn.mockRestore();
      }
    });

    test('a URL stored under another collection keeps its row, cards and collection', () => {
      listingManager.upsertFromRun('blue-ocean', OTHER, [blue12], 1000);
      const warn = spyOn(logger, 'warn');
      let found;
      try {
        found = listingManager.upsertFromRun(
          'blue-ocean',
          'lego-minecraft-3',
          [{ ...blue12, title: 'changed', cardIds: [cid('45')] }],
          2000
        );
        expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
          `blue-ocean (lego-minecraft-3): 1 listing(s) stored under another collection left unchanged: ${blue12.url} (other-set)`,
        ]);
      } finally {
        warn.mockRestore();
      }
      expect(found).toEqual([]);
      const kept = listingManager.getByUrl(blue12.url)!;
      expect(kept).toMatchObject({
        collection: OTHER,
        title: blue12.title,
        lastSeenAt: 1000,
        available: true,
      });
      expect(kept.cardIds).toEqual(ids('12'));
    });

    test('card reads and notifications stay inside the listing collection', () => {
      listingManager.upsertFromRun('blue-ocean', OTHER, [blue12], 1000);
      userManager.setList('u1', 'lego-minecraft-3', '12');
      expect(listingManager.listingsForCards('lego-minecraft-3', [cid('12')])).toEqual([]);
      expect(listingManager.listingsForCards(OTHER, [cid('12')]).map((l) => l.url)).toEqual([
        blue12.url,
      ]);
      expect(listingManager.pendingNotifications({ now: 1000 })).toEqual(new Map());
    });

    test('an eBay listing whose title names another collection moves there', () => {
      const item = {
        ...blue12,
        shop: 'ebay' as const,
        url: 'https://www.ebay.de/itm/1',
        format: 'fixed_price' as const,
      };
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [item], 1000);
      const moved = listingManager.upsertFromRun(
        'ebay',
        'lego-minecraft-1',
        [
          {
            ...item,
            title: 'LEGO Minecraft Serie 1 Trading Card 45 - X - Skin Karte',
            cardIds: ids('45'),
          },
        ],
        2000,
        { moveFromOtherCollections: true }
      );
      expect(moved.map((l) => l.url)).toEqual([item.url]);
      expect(listingManager.getByUrl(item.url)).toMatchObject({
        collection: 'lego-minecraft-1',
        cardIds: ids('45'),
        matchStatus: 'pending',
      });
      // A new availability period: the old collection's alert is no alert for this one.
      expect(listingManager.getByUrl(item.url)!.availableSince).toBe(2000);
    });

    test('a moved listing with the same card numbers is compared again in its new collection', () => {
      const item = {
        ...blue12,
        shop: 'ebay' as const,
        url: 'https://www.ebay.de/itm/3',
        format: 'fixed_price' as const,
      };
      const [l] = listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [item], 1000);
      listingManager.setMatch(
        l!.id,
        { status: 'confirmed', similarity: 0.93, picture: { cardId: cid('12'), similarity: 0.93 } },
        1500
      );
      listingManager.markMismatchNoted(l!.id, 1600);
      listingManager.upsertFromRun('ebay', 'lego-minecraft-1', [item], 2000, {
        moveFromOtherCollections: true,
      });
      expect(listingManager.getByUrl(item.url)).toMatchObject({
        collection: 'lego-minecraft-1',
        cardIds: ids('12'),
        matchStatus: 'pending',
        similarity: null,
        pictureCardId: null,
        rematchFrom: null,
      });
      // An old mismatch note was the other collection's: a mismatch here is noted again.
      expect(
        db.select().from(listings).where(eq(listings.url, item.url)).get()!.mismatchNotedAt
      ).toBeNull();
      // A bundle that moves is a bundle there.
      const bundle = { ...item, url: 'https://www.ebay.de/itm/4', cardIds: ids('12', '13') };
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [bundle], 1000);
      listingManager.upsertFromRun('ebay', 'lego-minecraft-1', [bundle], 2000, {
        moveFromOtherCollections: true,
      });
      expect(listingManager.getByUrl(bundle.url)!.matchStatus).toBe('bundle');
    });

    test('a listing the run saw in another collection is not marked gone', () => {
      const item = {
        ...blue12,
        shop: 'ebay' as const,
        url: 'https://www.ebay.de/itm/5',
        format: 'fixed_price' as const,
      };
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [item], 1000);
      const later = 1000 + 7 * 24 * 60 * 60 * 1000;
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [], later, {
        seenUrls: new Set([item.url]),
      });
      expect(listingManager.getByUrl(item.url)!.available).toBe(true);
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [], later);
      expect(listingManager.getByUrl(item.url)!.available).toBe(false);
    });

    test('a listing of another shop is never moved', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      expect(
        listingManager.upsertFromRun(
          'ebay',
          'lego-minecraft-1',
          [{ ...blue12, shop: 'ebay' }],
          2000,
          {
            moveFromOtherCollections: true,
          }
        )
      ).toEqual([]);
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        shop: 'blue-ocean',
        collection: 'lego-minecraft-3',
      });
    });

    test('an admin-mapped eBay listing stays in its collection', () => {
      const item = {
        ...blue12,
        shop: 'ebay' as const,
        url: 'https://www.ebay.de/itm/2',
        format: 'fixed_price' as const,
      };
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [item], 1000);
      listingManager.overrideCards(
        item.url,
        { collection: 'lego-minecraft-3', ids: ids('12') },
        1500
      );
      expect(
        listingManager.upsertFromRun('ebay', 'lego-minecraft-1', [item], 2000, {
          moveFromOtherCollections: true,
        })
      ).toEqual([]);
      expect(listingManager.getByUrl(item.url)).toMatchObject({ collection: 'lego-minecraft-3' });
    });

    test('overrideCards sets the collection, and a rescrape keeps cards and collection', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      const mapped = listingManager.overrideCards(
        blue12.url,
        { collection: 'lego-minecraft-3', ids: ids('45') },
        2000
      );
      expect(mapped).toMatchObject({ collection: 'lego-minecraft-3', cardIds: ids('45') });
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 3000);
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        collection: 'lego-minecraft-3',
        cardIds: ids('45'),
        manualOverride: true,
      });
    });

    test('rematchMismatches only resets mismatches of its collection', () => {
      listingManager.upsertFromRun('blue-ocean', OTHER, [blue12], 1000);
      const { id } = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(
        id,
        { status: 'mismatch', similarity: 0.5, picture: { cardId: cid('45'), similarity: 0.95 } },
        1000
      );
      listingManager.rematchMismatches('lego-minecraft-3', ids('12', '45'));
      expect(listingManager.getById(id)!.matchStatus).toBe('mismatch');
      listingManager.rematchMismatches(OTHER, ids('12'));
      expect(listingManager.getById(id)!.matchStatus).toBe('pending');
    });
  });

  test('a stored listing carries when it was last seen', () => {
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
    expect(listingManager.getByUrl(blue12.url)!.lastSeenAt).toBe(1000);
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [], 2000);
    expect(listingManager.listingsForCards('lego-minecraft-3', [cid('12')])[0]!.lastSeenAt).toBe(
      1000
    );
  });

  describe('notification periods', () => {
    beforeEach(() => {
      userManager.setList('u1', 'lego-minecraft-3', '12');
    });

    test('a new available listing is pending once, with its availability period', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      const pending = listingManager.pendingNotifications().get('u1')!;
      expect(pending).toHaveLength(1);
      expect(pending[0]!.availableSince).toBe(1000);
      expect(listingManager.getByUrl(blue12.url)!.availableSince).toBe(1000);
    });

    test('staying in stock never re-notifies', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.recordNotified('u1', l.id, l.availableSince!);
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 2000);
      expect(listingManager.pendingNotifications().get('u1')).toBeUndefined();
    });

    test('sold out then back in stock re-notifies exactly once', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.recordNotified('u1', l.id, l.availableSince!);
      listingManager.upsertFromRun(
        'blue-ocean',
        'lego-minecraft-3',
        [{ ...blue12, available: false }],
        3000
      );
      expect(listingManager.getByUrl(blue12.url)!.availableSince).toBeNull();
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 4000);
      const pending = listingManager.pendingNotifications().get('u1')!;
      expect(pending).toHaveLength(1);
      expect(pending[0]!.availableSince).toBe(4000);
      listingManager.recordNotified('u1', l.id, 4000);
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 5000);
      expect(listingManager.pendingNotifications().get('u1')).toBeUndefined();
    });

    test('a listing missing from a successful fetch becomes unavailable', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [], 5000);
      expect(listingManager.getByUrl(blue12.url)!.available).toBe(false);
    });

    test('a listing on hold is not notified', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      listingManager.setOnHold(listingManager.getByUrl(blue12.url)!.id);
      expect(listingManager.pendingNotifications().get('u1')).toBeUndefined();
    });

    test('a hold survives rescrapes, a changed picture and a new availability period', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setOnHold(l.id);
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 2000);
      listingManager.upsertFromRun(
        'blue-ocean',
        'lego-minecraft-3',
        [{ ...blue12, imageUrl: 'https://img/new.jpg' }],
        3000
      );
      listingManager.upsertFromRun(
        'blue-ocean',
        'lego-minecraft-3',
        [{ ...blue12, available: false }],
        4000
      );
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 5000);
      expect(listingManager.getById(l.id)!.onHold).toBe(true);
      expect(listingManager.pendingNotifications().get('u1')).toBeUndefined();
    });
  });

  describe('admin mapping', () => {
    test('/admin map cards survive the next scrape of the same listing', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 6000);
      listingManager.overrideCards(
        blue12.url,
        { collection: 'lego-minecraft-3', ids: ids('8') },
        6500
      );
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 7000);
      expect(listingManager.getByUrl(blue12.url)!.cardIds).toEqual(ids('8'));
    });

    test('mapping re-opens notification and lifts the hold', () => {
      userManager.setList('u1', 'lego-minecraft-3', '12');
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 6000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.recordNotified('u1', l.id, l.availableSince!);
      listingManager.setOnHold(l.id);
      listingManager.overrideCards(
        blue12.url,
        { collection: 'lego-minecraft-3', ids: ids('12') },
        7500
      );
      expect(listingManager.getById(l.id)!.onHold).toBe(false);
      expect(listingManager.pendingNotifications().get('u1')).toHaveLength(1);
    });

    test('a mapped listing stays confirmed when its picture changes', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      listingManager.overrideCards(
        blue12.url,
        { collection: 'lego-minecraft-3', ids: ids('12') },
        1500
      );
      listingManager.upsertFromRun(
        'blue-ocean',
        'lego-minecraft-3',
        [{ ...blue12, imageUrl: 'https://img/new.jpg', idConflict: true }],
        2000
      );
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        matchStatus: 'confirmed',
        similarity: null,
        imageUrl: 'https://img/new.jpg',
        cardIds: ids('12'),
      });
    });
  });

  test('a new collect-it single starts pending and turns unavailable once it vanishes', () => {
    const collect12: Listing = {
      ...blue12,
      shop: 'collect-it',
      url: 'https://www.collect-it.de/12-Squid-Charakterkarte-Serie-3',
    };
    listingManager.upsertFromRun('collect-it', 'lego-minecraft-3', [collect12], 1000);
    expect(listingManager.getByUrl(collect12.url)).toMatchObject({
      shop: 'collect-it',
      matchStatus: 'pending',
      available: true,
    });
    // collect-it hides sold-out products: the listing just disappears from the category.
    listingManager.upsertFromRun('collect-it', 'lego-minecraft-3', [], 2000);
    expect(listingManager.getByUrl(collect12.url)!.available).toBe(false);
  });

  test('vanished listings of another shop are untouched', () => {
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
    listingManager.upsertFromRun('sammel-ente', 'lego-minecraft-3', [], 2000);
    expect(listingManager.getByUrl(blue12.url)!.available).toBe(true);
  });

  test('an eBay single read by its catalog name starts pending, so its picture is compared', () => {
    // nameMatchedCardIds gives an ordinary title listing: no idSource, one card id.
    const byName: Listing = {
      ...blue12,
      shop: 'ebay',
      url: 'https://www.ebay.de/itm/220000000131',
      title: 'LEGO Minecraft Karte 131 - Ghast',
      cardIds: [cid('131')],
    };
    listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [byName], 1000);
    expect(listingManager.getByUrl(byName.url)!.matchStatus).toBe('pending');
  });

  test('default match status and reset to pending when the image changes', () => {
    const bundle = { ...blue12, url: 'https://x/b', cardIds: ids('1', '2') };
    const ente = { ...blue12, shop: 'sammel-ente' as const, url: 'https://x/e' };
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12, bundle], 1000);
    listingManager.upsertFromRun('sammel-ente', 'lego-minecraft-3', [ente], 1000);
    expect(listingManager.getByUrl(bundle.url)!.matchStatus).toBe('bundle');
    // sammel-ente is compared like every shop (its pictures are no references any more).
    expect(listingManager.getByUrl(ente.url)!.matchStatus).toBe('pending');
    const l = listingManager.getByUrl(blue12.url)!;
    expect(l.matchStatus).toBe('pending');
    listingManager.setMatch(l.id, { status: 'confirmed', similarity: 0.93, picture: null }, 1500);
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12, bundle], 2000);
    expect(listingManager.getById(l.id)).toMatchObject({
      matchStatus: 'confirmed',
      similarity: 0.93,
      matchCheckedAt: 1500,
    });
    listingManager.upsertFromRun(
      'blue-ocean',
      'lego-minecraft-3',
      [{ ...blue12, imageUrl: 'https://img/new.jpg' }, bundle],
      3000
    );
    expect(listingManager.getById(l.id)).toMatchObject({
      matchStatus: 'pending',
      similarity: null,
      matchCheckedAt: null,
    });
    expect(listingManager.getById(l.id)!.price).toEqual({ cents: 199, currency: 'EUR' });
  });

  test('an id conflict that appears or goes away with the same picture resets to pending', () => {
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
    const l = listingManager.getByUrl(blue12.url)!;
    listingManager.setMatch(l.id, { status: 'confirmed', similarity: 0.93, picture: null }, 1500);
    listingManager.upsertFromRun(
      'blue-ocean',
      'lego-minecraft-3',
      [{ ...blue12, idConflict: true }],
      2000
    );
    expect(listingManager.getById(l.id)).toMatchObject({
      matchStatus: 'pending',
      idConflict: true,
    });
    listingManager.setMatch(l.id, { status: 'unconfirmed', similarity: 0.93, picture: null }, 2500);
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 3000);
    expect(listingManager.getById(l.id)).toMatchObject({
      matchStatus: 'pending',
      idConflict: false,
    });
  });

  test('pendingNotifications returns the intersection sorted, items by listing id', () => {
    userManager.setList('u1', 'lego-minecraft-3', '1, 2, LE8');
    listingManager.upsertFromRun(
      'blue-ocean',
      'lego-minecraft-3',
      [
        { ...blue12, cardIds: [cid('LE8'), cid('2'), cid('9')] },
        { ...blue12, url: 'https://x/2', cardIds: [cid('1')] },
      ],
      1000
    );
    const items = listingManager.pendingNotifications().get('u1')!;
    expect(items.map((i) => i.cardIds)).toEqual([ids('2', 'LE8'), ids('1')]);
    expect(items[0]!.listing.id).toBeLessThan(items[1]!.listing.id);
    expect(listingManager.pendingNotifications().has('u2')).toBe(false);
  });

  test('clearHold and overrideCards resolve open reports', () => {
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
    const l = listingManager.getByUrl(blue12.url)!;
    const report = { listingId: l.id, reporterId: 'r', reason: 'other' as const, createdAt: 1 };
    db.insert(reports).values(report).run();
    listingManager.setOnHold(l.id);
    expect(listingManager.clearHold(blue12.url)!.onHold).toBe(false);
    expect(db.select().from(reports).get()!.resolvedAt).not.toBeNull();
    db.update(reports).set({ resolvedAt: null }).run();
    const o = listingManager.overrideCards(
      blue12.url,
      { collection: 'lego-minecraft-3', ids: [cid('5'), cid('3')] },
      9000
    )!;
    expect(o).toMatchObject({
      cardIds: ['3', '5'],
      manualOverride: true,
      onHold: false,
      availableSince: 9000,
    });
    expect(db.select().from(reports).get()!.resolvedAt).toBe(9000);
    expect(
      listingManager.overrideCards('nope', { collection: 'lego-minecraft-3', ids: [cid('1')] }, 1)
    ).toBeUndefined();
    expect(listingManager.clearHold('nope')).toBeUndefined();
  });

  describe('eBay churn', () => {
    const HOUR = 60 * 60 * 1000;
    const ebay12: Listing = {
      ...blue12,
      shop: 'ebay',
      url: 'https://www.ebay.de/itm/1',
      format: 'fixed_price',
    };

    test('a missing eBay listing stays available for 24 h, then becomes unavailable', () => {
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [ebay12], 0);
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [], 23 * HOUR);
      expect(listingManager.getByUrl(ebay12.url)).toMatchObject({
        available: true,
        availableSince: 0,
      });
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [], 24 * HOUR + 1);
      expect(listingManager.getByUrl(ebay12.url)!.available).toBe(false);
    });

    test('an eBay item that drops out for one run and returns is not re-notified', () => {
      userManager.setList('u1', 'lego-minecraft-3', '12');
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [ebay12], 1000);
      const l = listingManager.getByUrl(ebay12.url)!;
      listingManager.recordNotified('u1', l.id, l.availableSince!);
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [], 1000 + HOUR);
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [ebay12], 1000 + 2 * HOUR);
      expect(listingManager.getByUrl(ebay12.url)!.availableSince).toBe(1000);
      expect(
        listingManager.pendingNotifications({ now: 1000 + 2 * HOUR }).get('u1')
      ).toBeUndefined();
    });

    test('other shops still drop a missing listing at once', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 0);
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [], HOUR);
      expect(listingManager.getByUrl(blue12.url)!.available).toBe(false);
    });

    test('an auction that has ended is unavailable, found or missing', () => {
      userManager.setList('u1', 'lego-minecraft-3', '12');
      const auction: Listing = {
        ...ebay12,
        format: 'auction',
        auctionEndsAt: 5 * HOUR,
      };
      const missing: Listing = { ...auction, url: 'https://www.ebay.de/itm/2' };
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [auction, missing], HOUR);
      expect(listingManager.pendingNotifications({ now: HOUR }).get('u1')).toHaveLength(2);
      // Ended but not yet re-fetched: not notified any more.
      expect(listingManager.pendingNotifications({ now: 6 * HOUR }).get('u1')).toBeUndefined();
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [auction], 6 * HOUR);
      expect(listingManager.getByUrl(auction.url)).toMatchObject({
        available: false,
        availableSince: null,
      });
      expect(listingManager.getByUrl(missing.url)!.available).toBe(false);
    });
  });

  test('pendingNotifications skips listings not seen since the cutoff', () => {
    userManager.setList('u1', 'lego-minecraft-3', '12');
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
    expect(listingManager.pendingNotifications({ seenSince: 1000 }).get('u1')).toHaveLength(1);
    expect(listingManager.pendingNotifications({ seenSince: 1001 }).get('u1')).toBeUndefined();
  });

  test('onHold lists held listings by id', () => {
    const [a, b] = listingManager.upsertFromRun(
      'blue-ocean',
      'lego-minecraft-3',
      [blue12, { ...blue12, url: 'https://x/2' }],
      1000
    );
    expect(listingManager.onHold()).toEqual([]);
    listingManager.setOnHold(b!.id);
    listingManager.setOnHold(a!.id);
    expect(listingManager.onHold().map((l) => l.id)).toEqual([a!.id, b!.id]);
  });

  test('overrideCards marks the listing confirmed by the admin', () => {
    listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
    const l = listingManager.getByUrl(blue12.url)!;
    listingManager.setMatch(l.id, { status: 'unconfirmed', similarity: 0.4, picture: null }, 1500);
    expect(
      listingManager.overrideCards(
        blue12.url,
        { collection: 'lego-minecraft-3', ids: [cid('12')] },
        2000
      )
    ).toMatchObject({
      matchStatus: 'confirmed',
      similarity: null,
    });
  });
  describe('confirmCards', () => {
    const IMAGE = imageFingerprint(blue12.imageUrl);
    const confirm = (id: number, cards: string[], now = 3000, image = IMAGE) =>
      listingManager.confirmCards({ listingId: id, cardIds: cards.map(cid), image }, now);

    function unconfirmed12() {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(
        l.id,
        { status: 'unconfirmed', similarity: 0.7, picture: null },
        1500
      );
      return l;
    }

    test('confirms with the current cards and keeps availableSince', () => {
      const l = unconfirmed12();
      listingManager.setOnHold(l.id);
      db.insert(reports)
        .values({ listingId: l.id, reporterId: 'r', reason: 'other', createdAt: 1 })
        .run();
      const result = confirm(l.id, ['12']);
      expect(result.kind).toBe('confirmed');
      expect(result.kind === 'confirmed' && result.listing).toMatchObject({
        cardIds: ['12'],
        matchStatus: 'confirmed',
        manualOverride: true,
        similarity: null,
        pictureCardId: null,
        onHold: false,
        availableSince: 1000,
      });
      expect(db.select().from(reports).get()!.resolvedAt).toBe(3000);
    });

    test('confirming never re-notifies a user who already had the alert', () => {
      userManager.setList('u1', 'lego-minecraft-3', '12');
      const l = unconfirmed12();
      listingManager.recordNotified('u1', l.id, l.availableSince!);
      confirm(l.id, ['12']);
      expect(listingManager.pendingNotifications().get('u1')).toBeUndefined();
    });

    test('confirming a held listing sends the held-back alert exactly once', () => {
      userManager.setList('u1', 'lego-minecraft-3', '12');
      const l = unconfirmed12();
      listingManager.setOnHold(l.id);
      expect(listingManager.pendingNotifications().get('u1')).toBeUndefined();
      confirm(l.id, ['12']);
      const pending = listingManager.pendingNotifications().get('u1')!;
      expect(pending.map((p) => p.listing.id)).toEqual([l.id]);
      listingManager.recordNotified('u1', l.id, pending[0]!.availableSince);
      confirm(l.id, ['12'], 4000);
      expect(listingManager.pendingNotifications().get('u1')).toBeUndefined();
    });

    test('a listing without a picture URL is confirmed by the fingerprint of none', () => {
      listingManager.upsertFromRun(
        'blue-ocean',
        'lego-minecraft-3',
        [{ ...blue12, imageUrl: null }],
        1000
      );
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(
        l.id,
        { status: 'unconfirmed', similarity: null, picture: null },
        1500
      );
      expect(confirm(l.id, ['12'], 3000, imageFingerprint(null)).kind).toBe('confirmed');
    });

    test('refuses when the cards changed, writing nothing', () => {
      const l = unconfirmed12();
      for (const cards of [['13'], ['12', '13'], []]) {
        expect(confirm(l.id, cards)).toEqual({ kind: 'stale', reason: 'cards' });
      }
      expect(listingManager.getById(l.id)).toMatchObject({
        matchStatus: 'unconfirmed',
        manualOverride: false,
        similarity: 0.7,
      });
    });

    test('a subset of a bundle is refused as changed cards', () => {
      listingManager.upsertFromRun(
        'blue-ocean',
        'lego-minecraft-3',
        [{ ...blue12, cardIds: [cid('12'), cid('13')] }],
        1000
      );
      const l = listingManager.getByUrl(blue12.url)!;
      expect(confirm(l.id, ['12'])).toEqual({ kind: 'stale', reason: 'cards' });
    });

    test('refuses when the picture URL changed since the admin saw it', () => {
      const l = unconfirmed12();
      const seen = imageFingerprint('https://img/old.jpg');
      expect(confirm(l.id, ['12'], 3000, seen)).toEqual({ kind: 'stale', reason: 'picture' });
      expect(listingManager.getById(l.id)!.manualOverride).toBe(false);
      expect(confirm(l.id, ['12']).kind).toBe('confirmed');
    });

    test('refuses a listing that is a mismatch or waits for a comparison', () => {
      const l = unconfirmed12();
      listingManager.setMatch(
        l.id,
        { status: 'mismatch', similarity: 0.5, picture: { cardId: cid('45'), similarity: 0.9 } },
        2000
      );
      expect(confirm(l.id, ['12'])).toEqual({ kind: 'stale', reason: 'status' });
      db.update(listings).set({ matchStatus: 'pending' }).where(eq(listings.id, l.id)).run();
      expect(confirm(l.id, ['12'])).toEqual({ kind: 'stale', reason: 'status' });
      expect(listingManager.getById(l.id)!.manualOverride).toBe(false);
    });

    test('an admin-mapped listing may be confirmed whatever its status', () => {
      const l = unconfirmed12();
      listingManager.overrideCards(
        blue12.url,
        { collection: 'lego-minecraft-3', ids: [cid('12')] },
        2000
      );
      db.update(listings).set({ matchStatus: 'pending' }).where(eq(listings.id, l.id)).run();
      expect(confirm(l.id, ['12']).kind).toBe('confirmed');
    });

    test('a missing listing is gone', () => {
      expect(confirm(424242, ['12'])).toEqual({ kind: 'gone' });
    });

    test('is idempotent', () => {
      const l = unconfirmed12();
      confirm(l.id, ['12']);
      const again = confirm(l.id, ['12'], 4000);
      expect(again.kind === 'confirmed' && again.listing).toMatchObject({
        matchStatus: 'confirmed',
        manualOverride: true,
        availableSince: 1000,
      });
    });

    test('survives a rescrape', () => {
      const l = unconfirmed12();
      confirm(l.id, ['12']);
      listingManager.upsertFromRun(
        'blue-ocean',
        'lego-minecraft-3',
        [{ ...blue12, imageUrl: 'https://img/new.jpg' }],
        5000
      );
      expect(listingManager.getById(l.id)).toMatchObject({
        matchStatus: 'confirmed',
        manualOverride: true,
        cardIds: ['12'],
      });
    });
  });

  describe('picture identification', () => {
    const HOUR = 60 * 60 * 1000;
    /** An eBay title naming no card, passed on for the picture to identify (rule 4). */
    const candidate: Listing = {
      ...blue12,
      shop: 'ebay',
      url: 'https://www.ebay.de/itm/77',
      title: 'LEGO Minecraft On Fire Serie 3 Squid',
      cardIds: [],
      imageUrl: 'https://i.ebayimg.com/77.jpg',
      format: 'fixed_price',
      idSource: 'picture',
    };
    const stored = () => listingManager.getByUrl(candidate.url)!;
    /** Store the candidate and let the picture decide card 12. */
    function decided(now = 1000): void {
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [candidate], now);
      listingManager.setMatch(
        stored().id,
        { status: 'confirmed', similarity: 0.91, picture: { cardId: cid('12'), similarity: 0.91 } },
        now + 1
      );
    }

    beforeEach(() => {
      userManager.setList('u1', 'lego-minecraft-3', '12');
    });

    test('a candidate is stored pending, without cards, and never notified', () => {
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [candidate], 1000);
      expect(stored()).toMatchObject({
        cardIds: [],
        idSource: 'picture',
        matchStatus: 'pending',
        pictureCardId: null,
      });
      expect(listingManager.pendingNotifications().size).toBe(0);
    });

    test('a titled listing has the id source title', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        idSource: 'title',
        pictureCardId: null,
      });
    });

    test("a decided candidate gets the picture's card, confirmed, and is notified once", () => {
      decided();
      expect(stored()).toMatchObject({
        cardIds: ['12'],
        idSource: 'picture',
        matchStatus: 'confirmed',
        similarity: 0.91,
        pictureCardId: '12',
      });
      const pending = listingManager.pendingNotifications().get('u1')!;
      expect(pending.map((p) => p.cardIds)).toEqual([[cid('12')]]);
      listingManager.recordNotified('u1', stored().id, stored().availableSince!);
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [candidate], 2000);
      expect(listingManager.pendingNotifications().get('u1')).toBeUndefined();
    });

    test('an undecided candidate stays without cards and is never notified', () => {
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [candidate], 1000);
      listingManager.setMatch(
        stored().id,
        { status: 'unconfirmed', similarity: null, picture: null },
        1001
      );
      expect(stored()).toMatchObject({ cardIds: [], matchStatus: 'unconfirmed' });
      expect(listingManager.pendingNotifications().size).toBe(0);
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [candidate], 2000);
      expect(stored().matchStatus).toBe('unconfirmed');
    });

    test('the same candidate rescraped keeps the card the picture gave it', () => {
      decided();
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [candidate], 2000);
      expect(stored()).toMatchObject({
        cardIds: ['12'],
        matchStatus: 'confirmed',
        pictureCardId: '12',
      });
    });

    test('a changed picture or title of a candidate clears its card for a new identification', () => {
      decided();
      listingManager.upsertFromRun(
        'ebay',
        'lego-minecraft-3',
        [{ ...candidate, imageUrl: 'https://i.ebayimg.com/78.jpg' }],
        2000
      );
      expect(stored()).toMatchObject({ cardIds: [], matchStatus: 'pending', pictureCardId: null });
      decided(3000);
      listingManager.upsertFromRun(
        'ebay',
        'lego-minecraft-3',
        [{ ...candidate, title: `${candidate.title} neu` }],
        4000
      );
      expect(stored()).toMatchObject({ cardIds: [], matchStatus: 'pending', pictureCardId: null });
    });

    test('a candidate whose title now names a card takes the title card', () => {
      decided();
      listingManager.upsertFromRun(
        'ebay',
        'lego-minecraft-3',
        [{ ...candidate, title: 'On Fire Karte 45', cardIds: [cid('45')], idSource: 'title' }],
        2000
      );
      expect(stored()).toMatchObject({
        cardIds: ['45'],
        idSource: 'title',
        matchStatus: 'pending',
        pictureCardId: null,
      });
    });

    test('a decided candidate missing from eBay keeps the 24 h grace', () => {
      decided(0);
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [], 23 * HOUR);
      expect(stored()).toMatchObject({ available: true, cardIds: ['12'] });
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [], 24 * HOUR + 2);
      expect(stored().available).toBe(false);
    });

    test('a mismatch holds the picture card and is never notified', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(
        l.id,
        { status: 'mismatch', similarity: 0.5, picture: { cardId: cid('45'), similarity: 0.5 } },
        1001
      );
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        cardIds: ['12'],
        matchStatus: 'mismatch',
        pictureCardId: '45',
      });
      userManager.setList('u2', 'lego-minecraft-3', '45');
      expect(listingManager.pendingNotifications().size).toBe(0);
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 2000);
      expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('mismatch');
    });

    test('a rescrape with a changed picture or title compares a mismatch again', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(
        l.id,
        { status: 'mismatch', similarity: 0.5, picture: { cardId: cid('45'), similarity: 0.5 } },
        1001
      );
      listingManager.upsertFromRun(
        'blue-ocean',
        'lego-minecraft-3',
        [{ ...blue12, title: 'Sticker Card 12 neu' }],
        2000
      );
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        matchStatus: 'pending',
        pictureCardId: null,
      });
      listingManager.setMatch(
        l.id,
        { status: 'mismatch', similarity: 0.5, picture: { cardId: cid('45'), similarity: 0.5 } },
        2001
      );
      listingManager.upsertFromRun(
        'blue-ocean',
        'lego-minecraft-3',
        [{ ...blue12, title: 'Sticker Card 12 neu', imageUrl: 'https://img/12b.jpg' }],
        3000
      );
      expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('pending');
    });

    test('a confirmed titled listing is not compared again for a changed title alone', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(
        l.id,
        { status: 'confirmed', similarity: 0.9, picture: { cardId: cid('12'), similarity: 0.9 } },
        1001
      );
      listingManager.upsertFromRun(
        'blue-ocean',
        'lego-minecraft-3',
        [{ ...blue12, title: 'Sticker Card 12 neu' }],
        2000
      );
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        matchStatus: 'confirmed',
        pictureCardId: '12',
      });
    });

    test('/admin map on a mismatch or a candidate is final: confirmed, no picture card, kept on rescrape', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(
        l.id,
        { status: 'mismatch', similarity: 0.5, picture: { cardId: cid('45'), similarity: 0.5 } },
        1001
      );
      expect(
        listingManager.overrideCards(
          blue12.url,
          { collection: 'lego-minecraft-3', ids: [cid('45')] },
          2000
        )
      ).toMatchObject({
        cardIds: ['45'],
        matchStatus: 'confirmed',
        pictureCardId: null,
        manualOverride: true,
      });

      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [candidate], 1000);
      listingManager.overrideCards(
        candidate.url,
        { collection: 'lego-minecraft-3', ids: [cid('12')] },
        2000
      );
      listingManager.upsertFromRun(
        'ebay',
        'lego-minecraft-3',
        [{ ...candidate, title: 'changed', imageUrl: 'https://i.ebayimg.com/79.jpg' }],
        3000
      );
      expect(stored()).toMatchObject({
        cardIds: ['12'],
        matchStatus: 'confirmed',
        manualOverride: true,
      });
    });

    test('setMatch on a mapped candidate never touches its cards', () => {
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [candidate], 1000);
      listingManager.overrideCards(
        candidate.url,
        { collection: 'lego-minecraft-3', ids: [cid('12')] },
        2000
      );
      listingManager.setMatch(
        stored().id,
        { status: 'unconfirmed', similarity: null, picture: null },
        2001
      );
      expect(stored().cardIds).toEqual([cid('12')]);
    });
  });
  describe('mismatch notes and reference changes', () => {
    const mismatch45 = {
      status: 'mismatch',
      similarity: 0.5,
      picture: { cardId: cid('45'), similarity: 0.95 },
    } as const;

    test('a new mismatch waits for its admin note until marked noted (R5)', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(l.id, mismatch45, 1001);
      expect(listingManager.pendingMismatchNotes().map((x) => x.id)).toEqual([l.id]);
      listingManager.markMismatchNoted(l.id, 1002);
      expect(listingManager.pendingMismatchNotes()).toEqual([]);
      // Compared again with the same outcome: a new note is due (the alert throttle decides).
      listingManager.setMatch(l.id, mismatch45, 2001);
      expect(listingManager.pendingMismatchNotes().map((x) => x.id)).toEqual([l.id]);
    });

    describe('rematchFrom is cleared with every final status', () => {
      const waiting = (from: LegacyMatchStatus = 'mismatch') => {
        listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
        const l = listingManager.getByUrl(blue12.url)!;
        db.update(listings).set({ rematchFrom: from }).where(eq(listings.id, l.id)).run();
        return l;
      };

      test('pendingNotifications holds back only a listing that was a mismatch', () => {
        userManager.setList('u1', 'lego-minecraft-3', '12, 13, 14');
        const of = (id: string) => ({ ...blue12, url: `https://x/${id}`, cardIds: ids(id) });
        listingManager.upsertFromRun(
          'blue-ocean',
          'lego-minecraft-3',
          [of('12'), of('13'), of('14')],
          1000
        );
        const set = (id: string, from: LegacyMatchStatus | null) =>
          db
            .update(listings)
            .set({ rematchFrom: from })
            .where(eq(listings.url, `https://x/${id}`))
            .run();
        set('12', 'mismatch');
        set('13', 'confirmed');
        set('14', null);
        const urls = (listingManager.pendingNotifications({ now: 1000 }).get('u1') ?? []).map(
          (n) => n.listing.url
        );
        expect(urls.sort()).toEqual(['https://x/13', 'https://x/14']);
      });

      test('an admin map clears it, so the listing is notified again', () => {
        userManager.setList('u1', 'lego-minecraft-3', '12');
        waiting();
        expect(listingManager.pendingNotifications({ now: 1000 }).get('u1')).toBeUndefined();
        listingManager.overrideCards(
          blue12.url,
          { collection: 'lego-minecraft-3', ids: ids('12') },
          2000
        );
        expect(listingManager.getByUrl(blue12.url)!.rematchFrom).toBeNull();
        expect(listingManager.pendingNotifications({ now: 2000 }).get('u1')).toHaveLength(1);
      });

      test('a rescrape into a bundle clears it', () => {
        waiting();
        listingManager.upsertFromRun(
          'blue-ocean',
          'lego-minecraft-3',
          [{ ...blue12, cardIds: ids('12', '13') }],
          2000
        );
        expect(listingManager.getByUrl(blue12.url)).toMatchObject({
          matchStatus: 'bundle',
          rematchFrom: null,
        });
      });

      test('setMatch clears it with a final status and keeps it with a retry status', () => {
        const l = waiting();
        listingManager.setMatch(
          l.id,
          { status: 'image_unavailable', similarity: null, picture: null },
          1001
        );
        expect(listingManager.getByUrl(blue12.url)!.rematchFrom).toBe('mismatch');
        listingManager.setMatch(
          l.id,
          { status: 'model_unavailable', similarity: null, picture: null },
          1002
        );
        expect(listingManager.getByUrl(blue12.url)!.rematchFrom).toBe('mismatch');
        // No reference left for the card: compared again every check, still held back.
        listingManager.setMatch(
          l.id,
          { status: 'no_reference', similarity: null, picture: null },
          1003
        );
        expect(listingManager.getByUrl(blue12.url)!.rematchFrom).toBe('mismatch');
        listingManager.setMatch(
          l.id,
          { status: 'unconfirmed', similarity: 0.5, picture: null },
          1004
        );
        expect(listingManager.getByUrl(blue12.url)!.rematchFrom).toBeNull();
      });
    });

    test('markMismatchesNoted marks every given mismatch at once', () => {
      const other = { ...blue12, url: 'https://x/13', cardIds: ids('13') };
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12, other], 1000);
      const a = listingManager.getByUrl(blue12.url)!;
      const b = listingManager.getByUrl(other.url)!;
      listingManager.setMatch(a.id, mismatch45, 1001);
      listingManager.setMatch(b.id, mismatch45, 1001);
      listingManager.markMismatchesNoted([], 1002);
      expect(listingManager.pendingMismatchNotes()).toHaveLength(2);
      listingManager.markMismatchesNoted([a.id, b.id], 1002);
      expect(listingManager.pendingMismatchNotes()).toEqual([]);
    });

    test('an admin-mapped mismatch needs no note', () => {
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(l.id, mismatch45, 1001);
      listingManager.overrideCards(
        blue12.url,
        { collection: 'lego-minecraft-3', ids: [cid('12')] },
        1500
      );
      expect(listingManager.pendingMismatchNotes()).toEqual([]);
    });

    test('a changed reference of the title or picture card compares a mismatch again (R12)', () => {
      const blue13: Listing = {
        ...blue12,
        url: 'https://www.blue-ocean.de/p/13',
        cardIds: [cid('13')],
      };
      listingManager.upsertFromRun('blue-ocean', 'lego-minecraft-3', [blue12, blue13], 1000);
      const a = listingManager.getByUrl(blue12.url)!;
      const b = listingManager.getByUrl(blue13.url)!;
      listingManager.setMatch(a.id, mismatch45, 1001);
      listingManager.setMatch(b.id, mismatch45, 1001);
      listingManager.rematchMismatches('lego-minecraft-3', [cid('12')]);
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        matchStatus: 'pending',
        pictureCardId: null,
      });
      expect(listingManager.getByUrl(blue13.url)!.matchStatus).toBe('mismatch');
      listingManager.rematchMismatches('lego-minecraft-3', [cid('45')]);
      expect(listingManager.getByUrl(blue13.url)!.matchStatus).toBe('pending');
      listingManager.rematchMismatches('lego-minecraft-3', []);
    });

    test('any changed reference also lets an undecided title naming no card be identified again', () => {
      const candidate: Listing = {
        ...blue12,
        shop: 'ebay',
        url: 'https://www.ebay.de/itm/88',
        format: 'fixed_price',
        idSource: 'picture',
        cardIds: [],
      };
      listingManager.upsertFromRun('ebay', 'lego-minecraft-3', [candidate], 1000);
      const l = listingManager.getByUrl(candidate.url)!;
      listingManager.setMatch(
        l.id,
        { status: 'unconfirmed', similarity: null, picture: null },
        1001
      );
      listingManager.rematchMismatches('lego-minecraft-3', []);
      expect(listingManager.getByUrl(candidate.url)!.matchStatus).toBe('unconfirmed');
      listingManager.rematchMismatches('lego-minecraft-3', [cid('LE10')]);
      expect(listingManager.getByUrl(candidate.url)!.matchStatus).toBe('pending');
    });
  });
});
