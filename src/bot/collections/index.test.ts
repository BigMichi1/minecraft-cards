import { describe, expect, test } from 'bun:test';
import { COLLECTION_IDS } from './ids';
import { COLLECTIONS, collectionById, collectionChoices } from './index';

describe('COLLECTIONS', () => {
  test('defines every collection id once, in registry order', () => {
    expect(COLLECTIONS.map((c) => c.id)).toEqual([...COLLECTION_IDS]);
  });

  test('uses slug-shaped ids', () => {
    for (const c of COLLECTIONS) expect(c.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

describe('collectionById', () => {
  test('finds the definition', () => {
    expect(collectionById('lego-minecraft-3').name).toBe('LEGO Minecraft Serie 3 "On Fire"');
  });
});

describe('collectionChoices', () => {
  test('lists every collection as a slash command choice', () => {
    expect(collectionChoices()).toEqual([
      { name: 'LEGO Minecraft Serie 3 "On Fire"', value: 'lego-minecraft-3' },
    ]);
  });
});
