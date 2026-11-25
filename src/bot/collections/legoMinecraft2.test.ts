import { describe, expect, test } from 'bun:test';
import { legoMinecraft2 } from './legoMinecraft2';

describe('legoMinecraft2', () => {
  test('is the series 2 collection, without laststicker scans', () => {
    expect(legoMinecraft2).toEqual({
      id: 'lego-minecraft-2',
      name: 'LEGO Minecraft Serie 2 "TNT Boom-Bastic"',
      laststicker: {
        set: 'blue_ocean_lego_minecraft_tnt_boom_bastic',
        scans: false,
        numberAliases: { XXL: 'XXL1' },
      },
      referenceFallbackShop: 'sammel-ente',
      shops: {
        'sammel-ente': {
          category: 'https://shop-sammel-ente.de/Minecraft/Serie-2/',
          series: 'Serie 2',
        },
        'blue-ocean': {
          categoryPath: 'trading-card-collection-boom-bastic',
          productCode: '00702502',
          picture: '_tcc-02',
          excludes: /\bTCC\s*2\b|\bBoom[-\s]?Bastic\b/i,
        },
        ebay: {
          queries: ['lego minecraft karten serie 2', 'lego minecraft boom bastic karte'],
          series: /\b(?:Series?|Staffel)\s*2\b|\bBoom[-\s]?Bastic\b/i,
        },
      },
    });
  });
});
