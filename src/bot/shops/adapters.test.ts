import { describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
import { createShopAdapters } from './adapters';

describe('createShopAdapters', () => {
  test('without eBay credentials: the three shops in SHOP_IDS order, and a warning', () => {
    const warn = spyOn(logger, 'warn');
    try {
      expect(createShopAdapters(null).map((a) => a.id)).toEqual([
        'sammel-ente',
        'blue-ocean',
        'collect-it',
      ]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('eBay disabled'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('with eBay credentials eBay comes last', () => {
    const adapters = createShopAdapters({ clientId: 'id', clientSecret: 'secret' });
    expect(adapters.map((a) => a.id)).toEqual(['sammel-ente', 'blue-ocean', 'collect-it', 'ebay']);
  });
});
