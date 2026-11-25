import { describe, expect, test } from 'bun:test';
import { TURBO_ATTAX_CARD_IDS } from '../cards/cardId';
import { turboAttax2026 } from './turboAttax2026';

describe('turboAttax2026', () => {
  test('is the Topps F1 Turbo Attax 2026 collection, its catalog from laststicker', () => {
    expect(turboAttax2026).toEqual({
      id: 'turbo-attax-2026',
      name: 'Topps F1 Turbo Attax 2026',
      cardIds: TURBO_ATTAX_CARD_IDS,
      kleinanzeigen: 'turbo-attax-2026',
      laststicker: { set: 'topps_formula_1_turbo_attax_2026' },
      shops: {
        'collect-it': {
          category:
            'https://www.collect-it.de/sammelkarten/formel1/Topps-Turbo-Attax-Formel-1-2026/Einzelkarten',
          series: '2026',
        },
      },
    });
  });
});
