import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { db, initializeDatabase } from './db';
import { cards, listingCards, listings, reports } from './schema/index';
import { catalogManager } from './catalogManager';
import { listingManager } from './listingManager';
import { reportManager } from './reportManager';
import { cid } from '../../test/cardIds';

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

  function makeListing() {
    return listingManager.upsertFromRun(
      'blue-ocean',
      'lego-minecraft-3',
      [
        {
          shop: 'blue-ocean',
          url: 'https://www.blue-ocean.de/p/12',
          title: 't',
          cardIds: [cid('12')],
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
    )[0]!;
  }

  test('only an open report whose admin DM went out counts as notified', () => {
    const l = makeListing();
    const report = { listingId: l.id, reporterId: 'u1', reason: 'other' as const, note: null };
    expect(reportManager.hasNotifiedOpenReport(l.id)).toBe(false);
    const first = reportManager.create({ ...report, now: 1 });
    expect(reportManager.hasNotifiedOpenReport(l.id)).toBe(false);
    reportManager.markAdminNotified(first, 7);
    expect(reportManager.hasNotifiedOpenReport(l.id)).toBe(true);
    expect(db.select().from(reports).get()!.adminNotifiedAt).toBe(7);
    db.update(reports).set({ resolvedAt: 9 }).run();
    expect(reportManager.hasNotifiedOpenReport(l.id)).toBe(false);
  });

  test('unsentOpen lists the latest open report per listing the admin has not heard of', () => {
    const l = makeListing();
    const report = { listingId: l.id, reporterId: 'u1', reason: 'other' as const, note: null };
    expect(reportManager.unsentOpen()).toEqual([]);
    reportManager.create({ ...report, now: 1 });
    const second = reportManager.create({ ...report, note: 'b', now: 2 });
    expect(reportManager.unsentOpen().map((r) => r.id)).toEqual([second]);
    reportManager.markAdminNotified(second, 3);
    expect(reportManager.unsentOpen()).toEqual([]);
    db.update(reports).set({ resolvedAt: 4 }).run();
    reportManager.create({ ...report, now: 5 });
    db.update(reports).set({ resolvedAt: 6 }).run();
    expect(reportManager.unsentOpen()).toEqual([]);
  });

  test('create stores the report and puts the listing on hold', () => {
    const [l] = listingManager.upsertFromRun(
      'blue-ocean',
      'lego-minecraft-3',
      [
        {
          shop: 'blue-ocean',
          url: 'https://www.blue-ocean.de/p/12',
          title: 't',
          cardIds: [cid('12')],
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
    expect(row.adminNotifiedAt).toBeNull();
  });
});
