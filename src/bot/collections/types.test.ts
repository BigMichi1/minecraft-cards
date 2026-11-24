import { describe, expect, test } from 'bun:test';
import type { CollectionDefinition } from './types';

describe('CollectionDefinition', () => {
  test('takes a registered id and a display name', () => {
    const definition: CollectionDefinition = { id: 'lego-minecraft-3', name: 'Series 3' };
    // @ts-expect-error an id outside the registry is not a CollectionId
    const unknown: CollectionDefinition = { id: 'lego-minecraft-9', name: 'Series 9' };
    expect(definition.id).toBe('lego-minecraft-3');
    expect(unknown.name).toBe('Series 9');
  });
});
