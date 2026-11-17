import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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
import { userManager } from './userManager';
import type { Listing } from '../shops/types';
import { cid, ids } from '../../test/cardIds';

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

  describe('notification periods', () => {
    beforeEach(() => {
      userManager.setList('u1', '12');
    });

    test('a new available listing is pending once, with its availability period', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
      const pending = listingManager.pendingNotifications().get('u1')!;
      expect(pending).toHaveLength(1);
      expect(pending[0]!.availableSince).toBe(1000);
      expect(listingManager.getByUrl(blue12.url)!.availableSince).toBe(1000);
    });

    test('staying in stock never re-notifies', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.recordNotified('u1', l.id, l.availableSince!);
      listingManager.upsertFromRun('blue-ocean', [blue12], 2000);
      expect(listingManager.pendingNotifications().get('u1')).toBeUndefined();
    });

    test('sold out then back in stock re-notifies exactly once', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.recordNotified('u1', l.id, l.availableSince!);
      listingManager.upsertFromRun('blue-ocean', [{ ...blue12, available: false }], 3000);
      expect(listingManager.getByUrl(blue12.url)!.availableSince).toBeNull();
      listingManager.upsertFromRun('blue-ocean', [blue12], 4000);
      const pending = listingManager.pendingNotifications().get('u1')!;
      expect(pending).toHaveLength(1);
      expect(pending[0]!.availableSince).toBe(4000);
      listingManager.recordNotified('u1', l.id, 4000);
      listingManager.upsertFromRun('blue-ocean', [blue12], 5000);
      expect(listingManager.pendingNotifications().get('u1')).toBeUndefined();
    });

    test('a listing missing from a successful fetch becomes unavailable', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
      listingManager.upsertFromRun('blue-ocean', [], 5000);
      expect(listingManager.getByUrl(blue12.url)!.available).toBe(false);
    });

    test('a listing on hold is not notified', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
      listingManager.setOnHold(listingManager.getByUrl(blue12.url)!.id);
      expect(listingManager.pendingNotifications().get('u1')).toBeUndefined();
    });

    test('a hold survives rescrapes, a changed picture and a new availability period', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setOnHold(l.id);
      listingManager.upsertFromRun('blue-ocean', [blue12], 2000);
      listingManager.upsertFromRun(
        'blue-ocean',
        [{ ...blue12, imageUrl: 'https://img/new.jpg' }],
        3000
      );
      listingManager.upsertFromRun('blue-ocean', [{ ...blue12, available: false }], 4000);
      listingManager.upsertFromRun('blue-ocean', [blue12], 5000);
      expect(listingManager.getById(l.id)!.onHold).toBe(true);
      expect(listingManager.pendingNotifications().get('u1')).toBeUndefined();
    });
  });

  describe('admin mapping', () => {
    test('/admin map cards survive the next scrape of the same listing', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 6000);
      listingManager.overrideCards(blue12.url, ids('8'), 6500);
      listingManager.upsertFromRun('blue-ocean', [blue12], 7000);
      expect(listingManager.getByUrl(blue12.url)!.cardIds).toEqual(ids('8'));
    });

    test('mapping re-opens notification and lifts the hold', () => {
      userManager.setList('u1', '12');
      listingManager.upsertFromRun('blue-ocean', [blue12], 6000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.recordNotified('u1', l.id, l.availableSince!);
      listingManager.setOnHold(l.id);
      listingManager.overrideCards(blue12.url, ids('12'), 7500);
      expect(listingManager.getById(l.id)!.onHold).toBe(false);
      expect(listingManager.pendingNotifications().get('u1')).toHaveLength(1);
    });

    test('a mapped listing stays confirmed when its picture changes', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
      listingManager.overrideCards(blue12.url, ids('12'), 1500);
      listingManager.upsertFromRun(
        'blue-ocean',
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

  test('vanished listings of another shop are untouched', () => {
    listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
    listingManager.upsertFromRun('sammel-ente', [], 2000);
    expect(listingManager.getByUrl(blue12.url)!.available).toBe(true);
  });

  test('default match status and reset to pending when the image changes', () => {
    const bundle = { ...blue12, url: 'https://x/b', cardIds: ids('1', '2') };
    const ente = { ...blue12, shop: 'sammel-ente' as const, url: 'https://x/e' };
    listingManager.upsertFromRun('blue-ocean', [blue12, bundle], 1000);
    listingManager.upsertFromRun('sammel-ente', [ente], 1000);
    expect(listingManager.getByUrl(bundle.url)!.matchStatus).toBe('bundle');
    expect(listingManager.getByUrl(ente.url)!.matchStatus).toBe('reference');
    const l = listingManager.getByUrl(blue12.url)!;
    expect(l.matchStatus).toBe('pending');
    listingManager.setMatch(l.id, 'confirmed', 0.93, 1500);
    listingManager.upsertFromRun('blue-ocean', [blue12, bundle], 2000);
    expect(listingManager.getById(l.id)).toMatchObject({
      matchStatus: 'confirmed',
      similarity: 0.93,
      matchCheckedAt: 1500,
    });
    listingManager.upsertFromRun(
      'blue-ocean',
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
    listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
    const l = listingManager.getByUrl(blue12.url)!;
    listingManager.setMatch(l.id, 'confirmed', 0.93, 1500);
    listingManager.upsertFromRun('blue-ocean', [{ ...blue12, idConflict: true }], 2000);
    expect(listingManager.getById(l.id)).toMatchObject({
      matchStatus: 'pending',
      idConflict: true,
    });
    listingManager.setMatch(l.id, 'unconfirmed', 0.93, 2500);
    listingManager.upsertFromRun('blue-ocean', [blue12], 3000);
    expect(listingManager.getById(l.id)).toMatchObject({
      matchStatus: 'pending',
      idConflict: false,
    });
  });

  test('pendingNotifications returns the intersection sorted, items by listing id', () => {
    userManager.setList('u1', '1, 2, LE8');
    listingManager.upsertFromRun(
      'blue-ocean',
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
    listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
    const l = listingManager.getByUrl(blue12.url)!;
    const report = { listingId: l.id, reporterId: 'r', reason: 'other' as const, createdAt: 1 };
    db.insert(reports).values(report).run();
    listingManager.setOnHold(l.id);
    expect(listingManager.clearHold(blue12.url)!.onHold).toBe(false);
    expect(db.select().from(reports).get()!.resolvedAt).not.toBeNull();
    db.update(reports).set({ resolvedAt: null }).run();
    const o = listingManager.overrideCards(blue12.url, [cid('5'), cid('3')], 9000)!;
    expect(o).toMatchObject({
      cardIds: ['3', '5'],
      manualOverride: true,
      onHold: false,
      availableSince: 9000,
    });
    expect(db.select().from(reports).get()!.resolvedAt).toBe(9000);
    expect(listingManager.overrideCards('nope', [cid('1')], 1)).toBeUndefined();
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
      listingManager.upsertFromRun('ebay', [ebay12], 0);
      listingManager.upsertFromRun('ebay', [], 23 * HOUR);
      expect(listingManager.getByUrl(ebay12.url)).toMatchObject({
        available: true,
        availableSince: 0,
      });
      listingManager.upsertFromRun('ebay', [], 24 * HOUR + 1);
      expect(listingManager.getByUrl(ebay12.url)!.available).toBe(false);
    });

    test('an eBay item that drops out for one run and returns is not re-notified', () => {
      userManager.setList('u1', '12');
      listingManager.upsertFromRun('ebay', [ebay12], 1000);
      const l = listingManager.getByUrl(ebay12.url)!;
      listingManager.recordNotified('u1', l.id, l.availableSince!);
      listingManager.upsertFromRun('ebay', [], 1000 + HOUR);
      listingManager.upsertFromRun('ebay', [ebay12], 1000 + 2 * HOUR);
      expect(listingManager.getByUrl(ebay12.url)!.availableSince).toBe(1000);
      expect(
        listingManager.pendingNotifications({ now: 1000 + 2 * HOUR }).get('u1')
      ).toBeUndefined();
    });

    test('other shops still drop a missing listing at once', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 0);
      listingManager.upsertFromRun('blue-ocean', [], HOUR);
      expect(listingManager.getByUrl(blue12.url)!.available).toBe(false);
    });

    test('an auction that has ended is unavailable, found or missing', () => {
      userManager.setList('u1', '12');
      const auction: Listing = {
        ...ebay12,
        format: 'auction',
        auctionEndsAt: 5 * HOUR,
      };
      const missing: Listing = { ...auction, url: 'https://www.ebay.de/itm/2' };
      listingManager.upsertFromRun('ebay', [auction, missing], HOUR);
      expect(listingManager.pendingNotifications({ now: HOUR }).get('u1')).toHaveLength(2);
      // Ended but not yet re-fetched: not notified any more.
      expect(listingManager.pendingNotifications({ now: 6 * HOUR }).get('u1')).toBeUndefined();
      listingManager.upsertFromRun('ebay', [auction], 6 * HOUR);
      expect(listingManager.getByUrl(auction.url)).toMatchObject({
        available: false,
        availableSince: null,
      });
      expect(listingManager.getByUrl(missing.url)!.available).toBe(false);
    });
  });

  test('pendingNotifications skips listings not seen since the cutoff', () => {
    userManager.setList('u1', '12');
    listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
    expect(listingManager.pendingNotifications({ seenSince: 1000 }).get('u1')).toHaveLength(1);
    expect(listingManager.pendingNotifications({ seenSince: 1001 }).get('u1')).toBeUndefined();
  });

  test('onHold lists held listings by id', () => {
    const [a, b] = listingManager.upsertFromRun(
      'blue-ocean',
      [blue12, { ...blue12, url: 'https://x/2' }],
      1000
    );
    expect(listingManager.onHold()).toEqual([]);
    listingManager.setOnHold(b!.id);
    listingManager.setOnHold(a!.id);
    expect(listingManager.onHold().map((l) => l.id)).toEqual([a!.id, b!.id]);
  });

  test('overrideCards marks the listing confirmed by the admin', () => {
    listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
    const l = listingManager.getByUrl(blue12.url)!;
    listingManager.setMatch(l.id, 'unconfirmed', 0.4, 1500);
    expect(listingManager.overrideCards(blue12.url, [cid('12')], 2000)).toMatchObject({
      matchStatus: 'confirmed',
      similarity: null,
    });
  });
});
