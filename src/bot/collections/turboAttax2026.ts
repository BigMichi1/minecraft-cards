import { TURBO_ATTAX_CARD_IDS } from '../cards/cardId';
import type { CollectionDefinition } from './ids';

/**
 * Topps F1 Turbo Attax 2026. laststicker lists 422 cards (2026-11-25): base 1-353 without #135
 * (the admin adds it, `/admin catalog add`), LE, BG, GG, GU and SUN prefixed numbers and the relic codes `MR-…`
 * and `RR-…`, whose scans are missing (no reference: no shop's pictures stand in).
 */
export const turboAttax2026: CollectionDefinition<'turbo-attax-2026'> = {
  id: 'turbo-attax-2026',
  name: 'Topps F1 Turbo Attax 2026',
  cardIds: TURBO_ATTAX_CARD_IDS,
  kleinanzeigen: 'turbo-attax-2026',
  laststicker: { set: 'topps_formula_1_turbo_attax_2026' },
  shops: {
    // "MR-HAM - Lewis Hamilton - Manufactured Relic - 2026": 303 articles on 11 pages, sold-out
    // cards hidden (2026-11-25 probe).
    'collect-it': {
      category:
        'https://www.collect-it.de/sammelkarten/formel1/Topps-Turbo-Attax-Formel-1-2026/Einzelkarten',
      series: '2026',
    },
    // "Topps Turbo Attax 2026 Formel 1 Mark Webber Turbo Chrome #340 Trading Card", "LE4", "MR-VER"
    // (2026-11-25 probe): 4782 results need 24 pages of 200; 40 leave room to grow (8000).
    ebay: {
      queries: ['turbo attax 2026'],
      idForms: 'turbo-attax',
      maxPages: 40,
      // Both words, and no other year ("Miami GP 2023" is unclear).
      series:
        /^(?=.*\bTurbo\s*Attax\b)(?=.*(?<!\d)2026(?!\d))(?!.*(?<!\d)(?:19|20)(?!26)\d\d(?!\d))/i,
      // Parallels and other cards than the checklist's (spec "Non-goals"): any digit/digit
      // (numbered prints "03/99", "#269 /94", also "2/38"), Refractor, SuperFractor, Pink,
      // Rainbow, Green, Silver, Orange, Blue, Purple, Bronze, Printing Plate, autographs, and Gold
      // or Golden, but not the checklist sections "F1 Gold" and "Black Gold".
      excludes:
        /\b(?:pink|parallel|variante|refractor|superfractor|rainbow|green|silver|orange|blue|purple|bronze|golden|autogramm|autograph|signed|printing\s*plate)\b|\bgold\b(?<!\b(?:F1®?|Black)[\s-]+gold)|\d\s*\/\s*\d/i,
    },
  },
};
