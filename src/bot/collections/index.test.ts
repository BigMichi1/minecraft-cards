import { normalizeCardId, type CardId } from '../cards/cardId';
import { describe, expect, test } from 'bun:test';
import { COLLECTION_IDS } from './ids';
import type { CollectionId } from './ids';
import {
  COLLECTIONS,
  collectionById,
  collectionChoices,
  collectionName,
  notLoadedText,
} from './index';
import { SHOP_HOSTS } from '../shops/adapters';

describe('COLLECTIONS', () => {
  test('defines every collection id once, in registry order', () => {
    expect(COLLECTIONS.map((c) => c.id)).toEqual([...COLLECTION_IDS]);
  });

  test('the registry lists series 1, 2 and 3 in order', () => {
    expect([...COLLECTION_IDS]).toEqual([
      'lego-minecraft-1',
      'lego-minecraft-2',
      'lego-minecraft-3',
    ]);
  });

  test('only lego-minecraft-3 seeds a starter checklist', () => {
    expect(COLLECTIONS.filter((c) => c.starterChecklist).map((c) => c.id)).toEqual([
      'lego-minecraft-3',
    ]);
  });
});

describe('collectionById', () => {
  test('finds the definition', () => {
    expect(collectionById('lego-minecraft-3').name).toBe('LEGO Minecraft Serie 3 "On Fire"');
  });
});

describe('collectionName', () => {
  test('is the display name, or the id of a collection without definition', () => {
    expect(collectionName('lego-minecraft-3')).toBe('LEGO Minecraft Serie 3 "On Fire"');
    expect(collectionName('other-set' as CollectionId)).toBe('other-set');
  });
});

describe('collectionChoices', () => {
  test('lists every collection as a slash command choice', () => {
    expect(collectionChoices()).toEqual([
      { name: 'LEGO Minecraft Serie 1', value: 'lego-minecraft-1' },
      { name: 'LEGO Minecraft Serie 2 "TNT Boom-Bastic"', value: 'lego-minecraft-2' },
      { name: 'LEGO Minecraft Serie 3 "On Fire"', value: 'lego-minecraft-3' },
    ]);
  });

  test('every known twin is a canonical card id, and a pair names two cards', () => {
    for (const definition of COLLECTIONS) {
      for (const [a, b] of definition.knownTwins ?? []) {
        expect(normalizeCardId(a)).toBe(a as CardId);
        expect(normalizeCardId(b)).toBe(b as CardId);
        expect(a).not.toBe(b);
      }
    }
  });
});

describe('definition rules', () => {
  test('every collection is on blue-ocean, each with its own product code', () => {
    const codes = COLLECTIONS.map((d) => d.shops['blue-ocean']?.productCode);
    expect(codes.every((c) => c !== undefined && c.length > 0)).toBe(true);
    expect(new Set(codes).size).toBe(COLLECTIONS.length);
    const paths = COLLECTIONS.flatMap((d) => d.shops['blue-ocean']?.categoryPath ?? []);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('every collection is on eBay, and every series marker names only its own series', () => {
    const titles: Record<string, string> = {
      'lego-minecraft-1': 'LEGO Minecraft Serie 1 Trading Card 68 - Yeti - Skin Karte',
      'lego-minecraft-2': 'LEGO Minecraft Boom-Bastic Karte 12',
      'lego-minecraft-3': 'LEGO Minecraft On Fire Karte 12',
    };
    for (const d of COLLECTIONS) {
      expect(d.shops.ebay?.queries.length).toBeGreaterThan(0);
      for (const [id, title] of Object.entries(titles)) {
        expect(d.shops.ebay!.series.test(title)).toBe(id === d.id);
      }
    }
  });

  test('every category is on its shop host and every series label reads "Serie N"', () => {
    for (const d of COLLECTIONS) {
      for (const shop of ['sammel-ente', 'collect-it'] as const) {
        const settings = d.shops[shop];
        if (!settings) continue;
        expect(new URL(settings.category).hostname).toBe(SHOP_HOSTS[shop]);
        expect(settings.series).toMatch(/^Serie \d+$/);
      }
    }
  });

  test('a fallback shop is one the collection reads, and a set without scans has one', () => {
    for (const d of COLLECTIONS) {
      if (d.referenceFallbackShop) expect(d.shops[d.referenceFallbackShop]).toBeDefined();
      if (d.laststicker?.scans === false) expect(d.referenceFallbackShop).toBeDefined();
    }
  });

  test('every laststicker alias names a canonical card id', () => {
    for (const d of COLLECTIONS) {
      for (const id of Object.values(d.laststicker?.numberAliases ?? {})) {
        expect(normalizeCardId(id)).toBe(id as CardId);
      }
    }
  });
});

describe('notLoadedText', () => {
  test('names the collection and how its card list arrives', () => {
    expect(notLoadedText('lego-minecraft-2')).toBe(
      'The card list of LEGO Minecraft Serie 2 "TNT Boom-Bastic" is not loaded yet: it comes from laststicker with the next check (/admin catalog sync loads it now).'
    );
  });
});
