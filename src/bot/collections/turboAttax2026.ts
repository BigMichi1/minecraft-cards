import { TURBO_ATTAX_CARD_IDS } from '../cards/cardId';
import type { CollectionDefinition } from './ids';

/**
 * Topps F1 Turbo Attax 2026. laststicker lists 422 cards (2026-11-25): base 1-353 without #135
 * (the admin adds it, `/admin catalog add`), LE, BG, GG, GU and SUN codes and the relics `MR-…`
 * and `RR-…`, whose scans are missing (no reference: no shop's pictures stand in).
 */
export const turboAttax2026: CollectionDefinition<'turbo-attax-2026'> = {
  id: 'turbo-attax-2026',
  name: 'Topps F1 Turbo Attax 2026',
  cardIds: TURBO_ATTAX_CARD_IDS,
  kleinanzeigen: 'turbo-attax-2026',
  laststicker: { set: 'topps_formula_1_turbo_attax_2026' },
  shops: {},
};
