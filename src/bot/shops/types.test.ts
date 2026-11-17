import { describe, test, expect } from 'bun:test';
import { ShopLayoutError } from './types';

describe('ShopLayoutError', () => {
  test('is an Error with its own name', () => {
    const error = new ShopLayoutError('no cards');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ShopLayoutError);
    expect(error.name).toBe('ShopLayoutError');
    expect(error.message).toBe('no cards');
  });
});
