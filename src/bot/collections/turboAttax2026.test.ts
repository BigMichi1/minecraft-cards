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
        'euro-soccer-cards': {
          category: 'https://www.euro-soccer-cards.com/gb/topps-turbo-attax-2026/',
          slugSuffix: '-turbo-attax-2026',
        },
        ebay: {
          queries: ['turbo attax 2026'],
          idForms: 'turbo-attax',
          maxPages: 40,
          series: turboAttax2026.shops.ebay!.series,
          excludes: turboAttax2026.shops.ebay!.excludes,
        },
      },
    });
  });

  test('the eBay marker needs Turbo Attax and 2026, and no other year', () => {
    const marker = turboAttax2026.shops.ebay!.series;
    expect(marker.test('Topps Turbo Attax 2026 F1 Gold Max Verstappen #345')).toBe(true);
    expect(marker.test('TOPPS TURBO ATTAX F1 2026 LE5')).toBe(true);
    expect(marker.test('Topps Turbo Attax 2025 #12')).toBe(false);
    expect(marker.test('Topps Turbo Attax 2026 #101 Miami GP 2023')).toBe(false);
    expect(marker.test('Topps F1 2026 Chrome #12')).toBe(false);
    expect(marker.test('LEGO Minecraft Serie 3 2026 Karte 12')).toBe(false);
  });

  test('the parallel words exclude other cards, not the F1 Gold or Black Gold sections', () => {
    const parallel = turboAttax2026.shops.ebay!.excludes!;
    for (const title of [
      '#323 limitiert 03/99',
      'Signature Style Silver #269 /94',
      'Chrome Refractor #322',
      'SuperFractor 1 of 1',
      'Pink Diamond Pull #317',
      'Rainbow Foil',
      'Parallel/Variante Karte #41',
      'Green Max Verstappen',
      'LANDO NORRIS GOLD LE5',
      'Gold Relic',
      'Golden Max Verstappen',
      'Signature Style Silver #269',
      'Orange #12',
      'Blue Foil #12',
      'Purple #12',
      'Bronze #12',
      'Holo Autogramm 80',
      'Signed Auto #12',
      // "Auto" is the usual short form of an autograph; a car card so titled is missed.
      'Charles Leclerc Auto #LE6',
      '#12 Autograph',
      'Printing Plate #12',
    ]) {
      expect({ title, parallel: parallel.test(title) }).toEqual({ title, parallel: true });
    }
    for (const title of [
      'F1 Gold Max Verstappen #345',
      'F1® Gold #344',
      'BG 1 (Black Gold)',
      'Black-Gold BG1',
      'Oracle Red Bull #19',
      'Kimi Antonelli #231 Turbo Attax Legacy Hologramm',
      'Max Verstappen 100 Club Foil Karte #295',
      'Aston Martin Aramco #45',
      'Silverstone Exclusive',
    ]) {
      expect({ title, parallel: parallel.test(title) }).toEqual({ title, parallel: false });
    }
  });
});
