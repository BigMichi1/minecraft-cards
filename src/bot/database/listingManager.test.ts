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
    listingManager.upsertFromRun('blue-ocean', [blue12, blue45], 1000);
    listingManager.upsertFromRun('sammel-ente', [sammel12], 1000);
    listingManager.upsertFromRun('ebay', [bundle], 1000);
    const found = listingManager.listingsForCards([cid('12')]);
    expect(found.map((l) => l.url).sort()).toEqual([blue12.url, bundle.url, sammel12.url].sort());
    expect(found.find((l) => l.url === bundle.url)!.cardIds).toEqual(ids('12', '45'));
    expect(listingManager.listingsForCards([])).toEqual([]);
  });

  test('a stored listing carries when it was last seen', () => {
    listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
    expect(listingManager.getByUrl(blue12.url)!.lastSeenAt).toBe(1000);
    listingManager.upsertFromRun('blue-ocean', [], 2000);
    expect(listingManager.listingsForCards([cid('12')])[0]!.lastSeenAt).toBe(1000);
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

  test('a new collect-it single starts pending and turns unavailable once it vanishes', () => {
    const collect12: Listing = {
      ...blue12,
      shop: 'collect-it',
      url: 'https://www.collect-it.de/12-Squid-Charakterkarte-Serie-3',
    };
    listingManager.upsertFromRun('collect-it', [collect12], 1000);
    expect(listingManager.getByUrl(collect12.url)).toMatchObject({
      shop: 'collect-it',
      matchStatus: 'pending',
      available: true,
    });
    // collect-it hides sold-out products: the listing just disappears from the category.
    listingManager.upsertFromRun('collect-it', [], 2000);
    expect(listingManager.getByUrl(collect12.url)!.available).toBe(false);
  });

  test('vanished listings of another shop are untouched', () => {
    listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
    listingManager.upsertFromRun('sammel-ente', [], 2000);
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
    listingManager.upsertFromRun('ebay', [byName], 1000);
    expect(listingManager.getByUrl(byName.url)!.matchStatus).toBe('pending');
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
    listingManager.setMatch(l.id, { status: 'confirmed', similarity: 0.93, picture: null }, 1500);
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
    listingManager.setMatch(l.id, { status: 'confirmed', similarity: 0.93, picture: null }, 1500);
    listingManager.upsertFromRun('blue-ocean', [{ ...blue12, idConflict: true }], 2000);
    expect(listingManager.getById(l.id)).toMatchObject({
      matchStatus: 'pending',
      idConflict: true,
    });
    listingManager.setMatch(l.id, { status: 'unconfirmed', similarity: 0.93, picture: null }, 2500);
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
    listingManager.setMatch(l.id, { status: 'unconfirmed', similarity: 0.4, picture: null }, 1500);
    expect(listingManager.overrideCards(blue12.url, [cid('12')], 2000)).toMatchObject({
      matchStatus: 'confirmed',
      similarity: null,
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
      listingManager.upsertFromRun('ebay', [candidate], now);
      listingManager.setMatch(
        stored().id,
        { status: 'confirmed', similarity: 0.91, picture: { cardId: cid('12'), similarity: 0.91 } },
        now + 1
      );
    }

    beforeEach(() => {
      userManager.setList('u1', '12');
    });

    test('a candidate is stored pending, without cards, and never notified', () => {
      listingManager.upsertFromRun('ebay', [candidate], 1000);
      expect(stored()).toMatchObject({
        cardIds: [],
        idSource: 'picture',
        matchStatus: 'pending',
        pictureCardId: null,
      });
      expect(listingManager.pendingNotifications().size).toBe(0);
    });

    test('a titled listing has the id source title', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
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
      listingManager.upsertFromRun('ebay', [candidate], 2000);
      expect(listingManager.pendingNotifications().get('u1')).toBeUndefined();
    });

    test('an undecided candidate stays without cards and is never notified', () => {
      listingManager.upsertFromRun('ebay', [candidate], 1000);
      listingManager.setMatch(
        stored().id,
        { status: 'unconfirmed', similarity: null, picture: null },
        1001
      );
      expect(stored()).toMatchObject({ cardIds: [], matchStatus: 'unconfirmed' });
      expect(listingManager.pendingNotifications().size).toBe(0);
      listingManager.upsertFromRun('ebay', [candidate], 2000);
      expect(stored().matchStatus).toBe('unconfirmed');
    });

    test('the same candidate rescraped keeps the card the picture gave it', () => {
      decided();
      listingManager.upsertFromRun('ebay', [candidate], 2000);
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
        [{ ...candidate, imageUrl: 'https://i.ebayimg.com/78.jpg' }],
        2000
      );
      expect(stored()).toMatchObject({ cardIds: [], matchStatus: 'pending', pictureCardId: null });
      decided(3000);
      listingManager.upsertFromRun(
        'ebay',
        [{ ...candidate, title: `${candidate.title} neu` }],
        4000
      );
      expect(stored()).toMatchObject({ cardIds: [], matchStatus: 'pending', pictureCardId: null });
    });

    test('a candidate whose title now names a card takes the title card', () => {
      decided();
      listingManager.upsertFromRun(
        'ebay',
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
      listingManager.upsertFromRun('ebay', [], 23 * HOUR);
      expect(stored()).toMatchObject({ available: true, cardIds: ['12'] });
      listingManager.upsertFromRun('ebay', [], 24 * HOUR + 2);
      expect(stored().available).toBe(false);
    });

    test('a mismatch holds the picture card and is never notified', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
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
      userManager.setList('u2', '45');
      expect(listingManager.pendingNotifications().size).toBe(0);
      listingManager.upsertFromRun('blue-ocean', [blue12], 2000);
      expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('mismatch');
    });

    test('a rescrape with a changed picture or title compares a mismatch again', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(
        l.id,
        { status: 'mismatch', similarity: 0.5, picture: { cardId: cid('45'), similarity: 0.5 } },
        1001
      );
      listingManager.upsertFromRun(
        'blue-ocean',
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
        [{ ...blue12, title: 'Sticker Card 12 neu', imageUrl: 'https://img/12b.jpg' }],
        3000
      );
      expect(listingManager.getByUrl(blue12.url)!.matchStatus).toBe('pending');
    });

    test('a confirmed titled listing is not compared again for a changed title alone', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(
        l.id,
        { status: 'confirmed', similarity: 0.9, picture: { cardId: cid('12'), similarity: 0.9 } },
        1001
      );
      listingManager.upsertFromRun(
        'blue-ocean',
        [{ ...blue12, title: 'Sticker Card 12 neu' }],
        2000
      );
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        matchStatus: 'confirmed',
        pictureCardId: '12',
      });
    });

    test('/admin map on a mismatch or a candidate is final: confirmed, no picture card, kept on rescrape', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(
        l.id,
        { status: 'mismatch', similarity: 0.5, picture: { cardId: cid('45'), similarity: 0.5 } },
        1001
      );
      expect(listingManager.overrideCards(blue12.url, [cid('45')], 2000)).toMatchObject({
        cardIds: ['45'],
        matchStatus: 'confirmed',
        pictureCardId: null,
        manualOverride: true,
      });

      listingManager.upsertFromRun('ebay', [candidate], 1000);
      listingManager.overrideCards(candidate.url, [cid('12')], 2000);
      listingManager.upsertFromRun(
        'ebay',
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
      listingManager.upsertFromRun('ebay', [candidate], 1000);
      listingManager.overrideCards(candidate.url, [cid('12')], 2000);
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
      listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(l.id, mismatch45, 1001);
      expect(listingManager.pendingMismatchNotes().map((x) => x.id)).toEqual([l.id]);
      listingManager.markMismatchNoted(l.id, 1002);
      expect(listingManager.pendingMismatchNotes()).toEqual([]);
      // Compared again with the same outcome: a new note is due (the alert throttle decides).
      listingManager.setMatch(l.id, mismatch45, 2001);
      expect(listingManager.pendingMismatchNotes().map((x) => x.id)).toEqual([l.id]);
    });

    test('an admin-mapped mismatch needs no note', () => {
      listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
      const l = listingManager.getByUrl(blue12.url)!;
      listingManager.setMatch(l.id, mismatch45, 1001);
      listingManager.overrideCards(blue12.url, [cid('12')], 1500);
      expect(listingManager.pendingMismatchNotes()).toEqual([]);
    });

    test('a changed reference of the title or picture card compares a mismatch again (R12)', () => {
      const blue13: Listing = {
        ...blue12,
        url: 'https://www.blue-ocean.de/p/13',
        cardIds: [cid('13')],
      };
      listingManager.upsertFromRun('blue-ocean', [blue12, blue13], 1000);
      const a = listingManager.getByUrl(blue12.url)!;
      const b = listingManager.getByUrl(blue13.url)!;
      listingManager.setMatch(a.id, mismatch45, 1001);
      listingManager.setMatch(b.id, mismatch45, 1001);
      listingManager.rematchMismatches([cid('12')]);
      expect(listingManager.getByUrl(blue12.url)).toMatchObject({
        matchStatus: 'pending',
        pictureCardId: null,
      });
      expect(listingManager.getByUrl(blue13.url)!.matchStatus).toBe('mismatch');
      listingManager.rematchMismatches([cid('45')]);
      expect(listingManager.getByUrl(blue13.url)!.matchStatus).toBe('pending');
      listingManager.rematchMismatches([]);
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
      listingManager.upsertFromRun('ebay', [candidate], 1000);
      const l = listingManager.getByUrl(candidate.url)!;
      listingManager.setMatch(
        l.id,
        { status: 'unconfirmed', similarity: null, picture: null },
        1001
      );
      listingManager.rematchMismatches([]);
      expect(listingManager.getByUrl(candidate.url)!.matchStatus).toBe('unconfirmed');
      listingManager.rematchMismatches([cid('LE10')]);
      expect(listingManager.getByUrl(candidate.url)!.matchStatus).toBe('pending');
    });
  });
});
