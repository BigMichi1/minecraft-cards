import { describe, expect, test } from 'bun:test';
import { legoMinecraft1 } from './legoMinecraft1';

describe('legoMinecraft1', () => {
  test('is the series 1 collection', () => {
    expect(legoMinecraft1).toEqual({
      id: 'lego-minecraft-1',
      name: 'LEGO Minecraft Serie 1',
      laststicker: { set: 'blue_ocean_lego_minecraft-1' },
      referenceFallbackShop: 'sammel-ente',
      shops: {
        'sammel-ente': {
          category: 'https://shop-sammel-ente.de/Minecraft/Serie-1/',
          series: 'Serie 1',
        },
        'collect-it': {
          category:
            'https://www.collect-it.de/sammelwelt/sammelkarten/lego/minecraft/serie1/Einzelkarten',
          series: 'Serie 1',
        },
      },
    });
  });
});
