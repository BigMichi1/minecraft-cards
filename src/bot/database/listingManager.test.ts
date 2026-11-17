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

  test('notifies once per availability period', () => {
    userManager.setList('u1', '12');
    listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
    expect(listingManager.pendingNotifications().get('u1')).toHaveLength(1);
    const l = listingManager.getByUrl(blue12.url)!;
    expect(l.availableSince).toBe(1000);
    listingManager.recordNotified('u1', l.id, l.availableSince!);
    listingManager.upsertFromRun('blue-ocean', [blue12], 2000);
    expect(listingManager.pendingNotifications().get('u1') ?? []).toHaveLength(0);
    listingManager.upsertFromRun('blue-ocean', [{ ...blue12, available: false }], 3000);
    expect(listingManager.getByUrl(blue12.url)!.availableSince).toBeNull();
    listingManager.upsertFromRun('blue-ocean', [blue12], 4000);
    expect(listingManager.pendingNotifications().get('u1')).toHaveLength(1);
    listingManager.upsertFromRun('blue-ocean', [], 5000);
    expect(listingManager.getByUrl(blue12.url)!.available).toBe(false);

    listingManager.upsertFromRun('blue-ocean', [blue12], 6000);
    listingManager.overrideCards(blue12.url, ['8'], 6500);
    listingManager.upsertFromRun('blue-ocean', [blue12], 7000);
    expect(listingManager.getByUrl(blue12.url)!.cardIds).toEqual(['8']);

    userManager.setList('u1', '12');
    listingManager.overrideCards(blue12.url, ['12'], 7500);
    expect(listingManager.pendingNotifications().get('u1')).toHaveLength(1);
    listingManager.setOnHold(l.id);
    expect(listingManager.pendingNotifications().get('u1') ?? []).toHaveLength(0);
  });

  test('vanished listings of another shop are untouched', () => {
    listingManager.upsertFromRun('blue-ocean', [blue12], 1000);
    listingManager.upsertFromRun('sammel-ente', [], 2000);
    expect(listingManager.getByUrl(blue12.url)!.available).toBe(true);
  });

  test('default match status and reset when the image changes', () => {
    const bundle = { ...blue12, url: 'https://x/b', cardIds: ['1', '2'] };
    const ente = { ...blue12, shop: 'sammel-ente' as const, url: 'https://x/e' };
    listingManager.upsertFromRun('blue-ocean', [blue12, bundle], 1000);
    listingManager.upsertFromRun('sammel-ente', [ente], 1000);
    expect(listingManager.getByUrl(bundle.url)!.matchStatus).toBe('bundle');
    expect(listingManager.getByUrl(ente.url)!.matchStatus).toBe('reference');
    const l = listingManager.getByUrl(blue12.url)!;
    expect(l.matchStatus).toBe('unconfirmed');
    listingManager.setMatch(l.id, 'confirmed', 0.93);
    listingManager.upsertFromRun('blue-ocean', [blue12, bundle], 2000);
    expect(listingManager.getById(l.id)).toMatchObject({
      matchStatus: 'confirmed',
      similarity: 0.93,
    });
    listingManager.upsertFromRun(
      'blue-ocean',
      [{ ...blue12, imageUrl: 'https://img/new.jpg' }, bundle],
      3000
    );
    expect(listingManager.getById(l.id)).toMatchObject({
      matchStatus: 'unconfirmed',
      similarity: null,
    });
    expect(listingManager.getById(l.id)!.price).toEqual({ cents: 199, currency: 'EUR' });
  });

  test('pendingNotifications returns the intersection sorted, items by listing id', () => {
    userManager.setList('u1', '1, 2, LE8');
    listingManager.upsertFromRun(
      'blue-ocean',
      [
        { ...blue12, cardIds: ['LE8', '2', '9'] },
        { ...blue12, url: 'https://x/2', cardIds: ['1'] },
      ],
      1000
    );
    const items = listingManager.pendingNotifications().get('u1')!;
    expect(items.map((i) => i.cardIds)).toEqual([['2', 'LE8'], ['1']]);
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
    const o = listingManager.overrideCards(blue12.url, ['5', '3'], 9000)!;
    expect(o).toMatchObject({
      cardIds: ['3', '5'],
      manualOverride: true,
      onHold: false,
      availableSince: 9000,
    });
    expect(db.select().from(reports).get()!.resolvedAt).toBe(9000);
    expect(listingManager.overrideCards('nope', ['1'], 1)).toBeUndefined();
    expect(listingManager.clearHold('nope')).toBeUndefined();
  });
});
