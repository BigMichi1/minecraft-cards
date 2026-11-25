import { describe, expect, test } from 'bun:test';
import { MINECRAFT_CARD_IDS } from '../cards/cardId';
import { legoMinecraft1 } from './legoMinecraft1';

describe('legoMinecraft1', () => {
  test('is the series 1 collection', () => {
    expect(legoMinecraft1).toEqual({
      id: 'lego-minecraft-1',
      name: 'LEGO Minecraft Serie 1',
      cardIds: MINECRAFT_CARD_IDS,
      kleinanzeigen: 'lego-minecraft-karte',
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
        'blue-ocean': {
          categoryPath: 'trading-card-collection-serie-1',
          productCode: '702351',
          picture: '_tcc-01',
          title: /\bTCC\s*1\b/i,
        },
        ebay: {
          queries: ['lego minecraft karten serie 1', 'lego minecraft tcc serie 1'],
          series: /\b(?:Series?|Staffel)\s*1\b|\bTCC\s*1\b/i,
        },
      },
    });
  });
});
