import { describe, expect, test } from 'bun:test';
import { MINECRAFT_CARD_IDS } from '../cards/cardId';
import { STARTER_CHECKLIST } from '../cards/starterCatalog';
import { legoMinecraft3 } from './legoMinecraft3';

describe('legoMinecraft3', () => {
  test('is the series 3 collection', () => {
    expect(legoMinecraft3).toEqual({
      id: 'lego-minecraft-3',
      name: 'LEGO Minecraft Serie 3 "On Fire"',
      cardIds: MINECRAFT_CARD_IDS,
      kleinanzeigen: 'lego-minecraft-karte',
      starterChecklist: STARTER_CHECKLIST,
      laststicker: { set: 'blue_ocean_lego_minecraft_on_fire' },
      referenceFallbackShop: 'sammel-ente',
      knownTwins: [['59', 'XXL1']],
      shops: {
        'sammel-ente': {
          category: 'https://shop-sammel-ente.de/Minecraft/Serie-3/',
          series: 'Serie 3',
        },
        'blue-ocean': { productCode: '2dd00088', picture: 'tcg3_.p', title: /on fire/i },
        'collect-it': {
          category: 'https://www.collect-it.de/sammelkarten/lego/minecraft/serie-3/Einzelkarten',
          series: 'Serie 3',
        },
        ebay: legoMinecraft3.shops.ebay,
      },
    });
  });
});
