import { normalizeCardId, type CardId } from '../cards/cardId';
import { describe, expect, test } from 'bun:test';
import { COLLECTION_IDS } from './ids';
import type { CollectionId } from './ids';
import { COLLECTIONS, collectionById, collectionChoices, collectionName } from './index';

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
