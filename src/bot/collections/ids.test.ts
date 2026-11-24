import { describe, expect, test } from 'bun:test';
import { COLLECTION_IDS, DEFAULT_COLLECTION, isCollectionId } from './ids';

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

describe('DEFAULT_COLLECTION', () => {
  test('is the collection all data before collections belongs to', () => {
    expect(DEFAULT_COLLECTION).toBe('lego-minecraft-3');
    expect(COLLECTION_IDS).toContain(DEFAULT_COLLECTION);
  });
});
