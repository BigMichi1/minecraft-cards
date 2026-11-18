import { describe, expect, test } from 'bun:test';
import type { RunSummary } from '../check/runner';
import type { StoredListing } from '../database/listingManager';
import type { ShopId } from '../shops/types';
import { cid, ids } from '../../test/cardIds';
import { euro, runOf, storedListing as listing, T } from '../../test/listings';
import {
  listingState,
  needsLastSuccess,
  pictureBacked,
  shopCells,
  type CellContext,
  type ListingState,
} from './shopCell';

const ALL: readonly ShopId[] = ['sammel-ente', 'blue-ocean', 'collect-it', 'ebay'];

function ctx(over: Partial<CellContext> = {}): CellContext {
  return {
    latest: { summary: runOf(ALL), newerUnreadable: false },
    enabledShops: ALL,
    listings: [],
    now: T + 60_000,
    ...over,
  };
}

describe('listingState', () => {
  const now = T + 60_000;
  test.each<[ListingState, Partial<StoredListing>]>([
    ['sold_out', { available: false, onHold: true }],
    ['ended', { format: 'auction' as const, auctionEndsAt: now - 1, onHold: true }],
    ['paused', { onHold: true, matchStatus: 'mismatch' as const }],
    ['held_back', { matchStatus: 'mismatch' as const }],
    ['in_stock', { format: 'auction' as const, auctionEndsAt: now + 1 }],
  ])('%p', (state, over) => {
    expect(listingState(listing('ebay', ids('12'), over), now)).toBe(state);
  });
});

describe('pictureBacked', () => {
  test('reference and confirmed are backed; unconfirmed and bundle are not', () => {
    const of = (matchStatus: 'reference' | 'confirmed' | 'unconfirmed' | 'bundle') =>
      pictureBacked(listing('ebay', ids('12'), { matchStatus }));
    expect([of('reference'), of('confirmed'), of('unconfirmed'), of('bundle')]).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('needsLastSuccess', () => {
  test('only an enabled shop whose latest check failed or did not run', () => {
    const last = runOf(['sammel-ente'], ['blue-ocean']);
    expect(needsLastSuccess(last, 'sammel-ente', ALL)).toBe(false);
    expect(needsLastSuccess(last, 'blue-ocean', ALL)).toBe(true);
    expect(needsLastSuccess(last, 'ebay', ALL)).toBe(true);
    expect(needsLastSuccess(last, 'ebay', ['sammel-ente'])).toBe(false);
    expect(needsLastSuccess(undefined, 'ebay', ALL)).toBe(false);
  });
});

describe('shopCells', () => {
  test('a shop that is not enabled is not_enabled, even with listings', () => {
    const cell = shopCells(
      ctx({ enabledShops: ['sammel-ente'], listings: [listing('ebay', ids('12'))] })
    );
    expect(cell(cid('12'), 'ebay')).toEqual({ kind: 'not_enabled' });
  });

  test('without a readable run every enabled shop is unknown', () => {
    const cell = shopCells(
      ctx({
        latest: { summary: undefined, newerUnreadable: true },
        listings: [listing('sammel-ente', ids('12'))],
      })
    );
    expect(cell(cid('12'), 'sammel-ente')).toEqual({ kind: 'unknown' });
  });

  test('nothing stored: not_listed after a success, unknown after a failure or no check', () => {
    const cell = shopCells(
      ctx({ latest: { summary: runOf(['sammel-ente'], ['blue-ocean']), newerUnreadable: false } })
    );
    expect(cell(cid('12'), 'sammel-ente')).toEqual({ kind: 'not_listed' });
    expect(cell(cid('12'), 'blue-ocean')).toEqual({ kind: 'unknown' });
    expect(cell(cid('12'), 'ebay')).toEqual({ kind: 'unknown' });
  });

  test('the listing of another card or shop does not count', () => {
    const cell = shopCells(
      ctx({ listings: [listing('ebay', ids('13')), listing('blue-ocean', ids('12'))] })
    );
    expect(cell(cid('12'), 'ebay')).toEqual({ kind: 'not_listed' });
  });

  test('a bundle counts for each of its cards', () => {
    const bundle = listing('ebay', ids('12', '13'));
    const cell = shopCells(ctx({ listings: [bundle] }));
    for (const card of ids('12', '13')) {
      const c = cell(card, 'ebay');
      expect(c.kind === 'listed' && c.listing).toBe(bundle);
    }
  });

  test('in stock beats paused and held back, which beat sold out', () => {
    const sold = listing('ebay', ids('12'), { available: false, ...euro(1) });
    const paused = listing('ebay', ids('12'), { onHold: true, ...euro(2) });
    const held = listing('ebay', ids('12'), { matchStatus: 'mismatch', ...euro(3) });
    const stock = listing('ebay', ids('12'), euro(400));
    const at = (listings = [sold, paused, held, stock]) =>
      shopCells(ctx({ listings }))(cid('12'), 'ebay');
    expect(at()).toMatchObject({ kind: 'listed', listing: stock, state: 'in_stock' });
    expect(at([sold, paused])).toMatchObject({ listing: paused, state: 'paused', offers: [] });
    expect(at([sold, held])).toMatchObject({ listing: held, state: 'held_back', offers: [] });
    expect(at([sold])).toMatchObject({ listing: sold, state: 'sold_out', offers: [] });
  });

  test('a backed picture beats a cheaper unconfirmed one; then the lower price wins', () => {
    const unconfirmed = listing('ebay', ids('12'), { matchStatus: 'unconfirmed', ...euro(10) });
    const backed = listing('ebay', ids('12'), euro(90));
    const cheaper = listing('ebay', ids('12'), { matchStatus: 'confirmed', ...euro(80) });
    const noPrice = listing('ebay', ids('12'), { price: null });
    const c = shopCells(ctx({ listings: [unconfirmed, backed, noPrice, cheaper] }))(
      cid('12'),
      'ebay'
    );
    expect(c).toMatchObject({ listing: cheaper, stale: false });
    // Offers: backed singles first, cheapest first, no price last; then the rest.
    expect(c.kind === 'listed' && c.offers).toEqual([cheaper, backed, noPrice, unconfirmed]);
  });

  test('offers: backed singles, then other singles, then bundles, each cheapest first', () => {
    const bundle = listing('ebay', ids('12', '13'), { matchStatus: 'bundle', ...euro(10) });
    const pending = listing('ebay', ids('12'), { matchStatus: 'pending', ...euro(30) });
    const unconfirmed = listing('ebay', ids('12'), { matchStatus: 'unconfirmed', ...euro(20) });
    const single = listing('ebay', ids('12'), euro(500));
    const at = (listings: ReturnType<typeof listing>[]) => {
      const c = shopCells(ctx({ listings }))(cid('12'), 'ebay');
      return c.kind === 'listed' ? c.offers : [];
    };
    expect(at([bundle, pending, unconfirmed, single])).toEqual([
      single,
      unconfirmed,
      pending,
      bundle,
    ]);
    // Without a backed single, the unbacked singles lead, a bundle comes last.
    expect(at([bundle, pending, unconfirmed])).toEqual([unconfirmed, pending, bundle]);
  });

  test('prices in another currency count as no price, for the best listing and the offers', () => {
    const eur = listing('ebay', ids('12'), euro(200));
    const usd = listing('ebay', ids('12'), { price: { cents: 100, currency: 'USD' } });
    const c = shopCells(ctx({ listings: [usd, eur] }))(cid('12'), 'ebay');
    expect(c).toMatchObject({ listing: eur, offers: [eur, usd] });
    // Only listings in another currency: they compare among themselves.
    const usd2 = listing('ebay', ids('12'), { price: { cents: 50, currency: 'USD' } });
    const d = shopCells(ctx({ listings: [usd, usd2] }))(cid('12'), 'ebay');
    expect(d).toMatchObject({ listing: usd2, offers: [usd2, usd] });
  });

  test('offers leave out held-back, paused, sold-out and ended listings', () => {
    const now = T + 60_000;
    const stock = listing('ebay', ids('12'), euro(500));
    const c = shopCells(
      ctx({
        listings: [
          stock,
          listing('ebay', ids('12'), { matchStatus: 'mismatch', ...euro(1) }),
          listing('ebay', ids('12'), { onHold: true, ...euro(1) }),
          listing('ebay', ids('12'), { available: false, ...euro(1) }),
          listing('ebay', ids('12'), { format: 'auction', auctionEndsAt: now - 1, ...euro(1) }),
        ],
        now,
      })
    )(cid('12'), 'ebay');
    expect(c.kind === 'listed' && c.offers).toEqual([stock]);
  });

  test('a listing the latest successful check did not return is stale and ranks last', () => {
    const last: RunSummary = { ...runOf(ALL), startedAt: T + 10 };
    const unseen = listing('ebay', ids('12'), euro(10));
    const seen = listing('ebay', ids('12'), { lastSeenAt: T + 10, available: false });
    const at = (listings = [unseen, seen]) =>
      shopCells(ctx({ latest: { summary: last, newerUnreadable: false }, listings }))(
        cid('12'),
        'ebay'
      );
    // A seen sold-out listing beats an unseen in-stock one, and then nothing is offered.
    expect(at()).toMatchObject({ listing: seen, state: 'sold_out', stale: false, offers: [] });
    expect(at([unseen])).toMatchObject({ listing: unseen, stale: true, offers: [unseen] });
  });

  test('a stored listing of a shop whose check failed is stale', () => {
    const l = listing('blue-ocean', ids('12'));
    const c = shopCells(
      ctx({
        latest: { summary: runOf(['sammel-ente'], ['blue-ocean']), newerUnreadable: false },
        listings: [l],
      })
    )(cid('12'), 'blue-ocean');
    expect(c).toEqual({ kind: 'listed', listing: l, state: 'in_stock', stale: true, offers: [l] });
  });

  test('a listing naming the same card twice is counted once', () => {
    const l = listing('ebay', [cid('12'), cid('12')]);
    const c = shopCells(ctx({ listings: [l] }))(cid('12'), 'ebay');
    expect(c.kind === 'listed' && c.offers).toEqual([l]);
  });
});
