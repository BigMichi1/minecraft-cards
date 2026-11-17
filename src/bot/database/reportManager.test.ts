import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { db, initializeDatabase } from './db';
import { cards, listingCards, listings, reports } from './schema/index';
import { catalogManager } from './catalogManager';
import { listingManager } from './listingManager';
import { reportManager } from './reportManager';

describe('reportManager', () => {
  beforeAll(() => {
    initializeDatabase();
  });
  beforeEach(() => {
    db.delete(reports).run();
    db.delete(listingCards).run();
    db.delete(listings).run();
    db.delete(cards).run();
    catalogManager.seedIfEmpty();
  });

  test('create stores the report and puts the listing on hold', () => {
    const [l] = listingManager.upsertFromRun(
      'blue-ocean',
      [
        {
          shop: 'blue-ocean',
          url: 'https://www.blue-ocean.de/p/12',
          title: 't',
          cardIds: ['12'],
          cardName: null,
          imageUrl: null,
          price: null,
          available: true,
          format: 'shop',
          auctionEndsAt: null,
          idConflict: false,
        },
      ],
      1
    );
    const id = reportManager.create({
      listingId: l!.id,
      reporterId: 'u1',
      reason: 'wrong_number',
      note: 'shows #8',
      now: 1,
    });
    expect(listingManager.getById(l!.id)!.onHold).toBe(true);
    const row = db.select().from(reports).all()[0]!;
    expect(row.id).toBe(id);
    expect(row.note).toBe('shows #8');
    expect(row.resolvedAt).toBeNull();
  });
});
