import { describe, expect, test } from 'bun:test';
import { legoMinecraft1 } from './legoMinecraft1';

describe('legoMinecraft1', () => {
  test('is the series 1 collection', () => {
    expect(legoMinecraft1).toEqual({
      id: 'lego-minecraft-1',
      name: 'LEGO Minecraft Serie 1',
      laststicker: { set: 'blue_ocean_lego_minecraft-1' },
      referenceFallbackShop: 'sammel-ente',
    });
  });
});
