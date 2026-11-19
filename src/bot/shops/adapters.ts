import type { CardId } from '../cards/cardId';
import type { Config } from '../config';
import logger from '../utils/logger';
import { createBlueOceanAdapter } from './blueOcean';
import { createCollectItAdapter } from './collectIt';
import { createEbayAdapter } from './ebay';
import { createSammelEnteAdapter } from './sammelEnte';
import { SHOP_IDS, type ShopAdapter, type ShopId } from './types';

/**
 * One factory per shop that needs no credentials. A `ShopId` without an entry here is a
 * compile error, so a new shop cannot be left out of the checks by accident.
 */
const SHOP_FACTORIES: Record<Exclude<ShopId, 'ebay'>, () => ShopAdapter> = {
  'sammel-ente': () => createSammelEnteAdapter(),
  'blue-ocean': () => createBlueOceanAdapter(),
  'collect-it': () => createCollectItAdapter(),
};

/**
 * The shops this process checks, in SHOP_IDS order: every shop, plus eBay when its credentials
 * are set. `/missing status` shows the shops left out as not enabled. `cardNames` gives eBay the
 * catalog names for titles without a series word (read at the start of each eBay fetch, after
 * sammel-ente's in the same round).
 */
export function createShopAdapters(
  ebay: Config['ebay'],
  cardNames?: () => ReadonlyMap<CardId, string>
): ShopAdapter[] {
  if (!ebay) logger.warn('eBay disabled: EBAY_CLIENT_ID/EBAY_CLIENT_SECRET not set');
  return SHOP_IDS.flatMap((id): ShopAdapter[] => {
    if (id !== 'ebay') return [SHOP_FACTORIES[id]()];
    return ebay ? [createEbayAdapter({ ...ebay, ...(cardNames ? { cardNames } : {}) })] : [];
  });
}
