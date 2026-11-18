import type { Config } from '../config';
import logger from '../utils/logger';
import { createBlueOceanAdapter } from './blueOcean';
import { createCollectItAdapter } from './collectIt';
import { createEbayAdapter } from './ebay';
import { createSammelEnteAdapter } from './sammelEnte';
import type { ShopAdapter } from './types';

/**
 * The shops this process checks, in SHOP_IDS order: every shop, plus eBay when its credentials
 * are set. `/missing status` shows the shops left out as not enabled.
 */
export function createShopAdapters(ebay: Config['ebay']): ShopAdapter[] {
  const adapters: ShopAdapter[] = [
    createSammelEnteAdapter(),
    createBlueOceanAdapter(),
    createCollectItAdapter(),
  ];
  if (ebay) {
    adapters.push(createEbayAdapter(ebay));
  } else {
    logger.warn('eBay disabled: EBAY_CLIENT_ID/EBAY_CLIENT_SECRET not set');
  }
  return adapters;
}
