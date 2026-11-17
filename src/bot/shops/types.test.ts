import { describe, test, expect } from 'bun:test';
import { LISTING_FORMATS, SHOP_IDS, ShopLayoutError } from './types';

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
    expect(SHOP_IDS).toEqual(['sammel-ente', 'blue-ocean', 'ebay']);
    expect(LISTING_FORMATS).toEqual(['shop', 'auction', 'fixed_price']);
  });
});
