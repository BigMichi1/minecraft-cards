import { sameSeries } from './types';
import { describe, test, expect } from 'bun:test';
import { cid } from '../../test/cardIds';
import { LISTING_FORMATS, SHOP_IDS, ShopLayoutError, type Listing } from './types';

describe('ShopLayoutError', () => {
  test('is an Error with its own name', () => {
    const error = new ShopLayoutError('no cards');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect(error.name).toBe('ShopLayoutError');
    expect(error.message).toBe('no cards');
  });
});

describe('SHOP_IDS and LISTING_FORMATS', () => {
  test('list each value once', () => {
    expect(SHOP_IDS).toEqual(['sammel-ente', 'blue-ocean', 'collect-it', 'ebay']);
    expect(LISTING_FORMATS).toEqual(['shop', 'auction', 'fixed_price']);
  });
});

describe('Listing', () => {
  const fields = {
    shop: 'ebay',
    url: 'https://www.ebay.de/itm/1',
    title: 't',
    cardName: null,
    imageUrl: null,
    price: null,
    available: true,
    format: 'fixed_price',
    auctionEndsAt: null,
    idConflict: false,
  } as const;

  test('a picture-only listing carries no card ids (checked by the type checker, T6)', () => {
    const titled: Listing = { ...fields, cardIds: [cid('12')] };
    const pictureOnly: Listing = { ...fields, idSource: 'picture', cardIds: [] };
    // @ts-expect-error A listing whose card comes from the picture has no title ids.
    const wrong: Listing = { ...fields, idSource: 'picture', cardIds: [cid('12')] };
    expect([titled, pictureOnly, wrong].map((l) => l.cardIds.length)).toEqual([1, 0, 1]);
  });
});

describe('sameSeries', () => {
  test('compares the series numbers as numbers', () => {
    expect(sameSeries('Serie 1', 'Serie 01')).toBe(true);
    expect(sameSeries('1', 'Serie 1')).toBe(true);
    expect(sameSeries('Serie 13', 'Serie 1')).toBe(false);
    expect(sameSeries('Serie', 'Serie')).toBe(false);
  });
});
