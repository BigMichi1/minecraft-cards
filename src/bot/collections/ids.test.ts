import { describe, expect, test } from 'bun:test';
import {
  COLLECTION_IDS,
  LEGACY_COLLECTION,
  isCollectionId,
  type CollectionDefinition,
} from './ids';

describe('isCollectionId', () => {
  test('accepts a registered collection id', () => {
    expect(isCollectionId('lego-minecraft-3')).toBe(true);
  });

  test('rejects unknown and empty values', () => {
    expect(isCollectionId('lego-minecraft-9')).toBe(false);
    expect(isCollectionId('')).toBe(false);
    expect(isCollectionId('LEGO-MINECRAFT-3')).toBe(false);
  });
});

describe('LEGACY_COLLECTION', () => {
  test('is the collection all data before collections belongs to', () => {
    expect(LEGACY_COLLECTION).toBe('lego-minecraft-3');
    expect(COLLECTION_IDS).toContain(LEGACY_COLLECTION);
  });
});

describe('COLLECTION_IDS', () => {
  test('are unique slugs starting with a letter (custom ids split on ":" and embed them unescaped)', () => {
    expect(new Set(COLLECTION_IDS).size).toBe(COLLECTION_IDS.length);
    for (const id of COLLECTION_IDS) expect(id).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
  });
});

describe('CollectionDefinition', () => {
  test('takes a registered id and a display name', () => {
    const definition: CollectionDefinition = { id: 'lego-minecraft-3', name: 'Series 3' };
    // @ts-expect-error an id outside the registry is not a CollectionId
    const unknown: CollectionDefinition = { id: 'lego-minecraft-9', name: 'Series 9' };
    expect(definition.id).toBe('lego-minecraft-3');
    expect(unknown.name).toBe('Series 9');
  });
});
