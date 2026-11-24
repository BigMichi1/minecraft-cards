import { describe, expect, test } from 'bun:test';
import { COLLECTION_IDS } from './ids';
import type { CollectionId } from './ids';
import { COLLECTIONS, collectionById, collectionChoices, collectionName } from './index';

describe('COLLECTIONS', () => {
  test('defines every collection id once, in registry order', () => {
    expect(COLLECTIONS.map((c) => c.id)).toEqual([...COLLECTION_IDS]);
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
      { name: 'LEGO Minecraft Serie 3 "On Fire"', value: 'lego-minecraft-3' },
    ]);
  });
});
