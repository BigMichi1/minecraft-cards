import { MINECRAFT_CARD_IDS } from '../cards/cardId';
import type { CollectionDefinition } from './ids';

export const legoMinecraft1: CollectionDefinition<'lego-minecraft-1'> = {
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
    // "Nummer 250 I Schildkröte I LEGO Minecraft TCC 1", picture 250_lego_minecraft_tcc-01_de.jpg;
    // #1-9 at root URLs ("…-i-lego-minecraft-tcc-1-702351-01") (2026-11-24 probe).
    'blue-ocean': {
      categoryPath: 'trading-card-collection-serie-1',
      productCode: '702351',
      picture: '_tcc-01',
      title: /\bTCC\s*1\b/i,
    },
    // "LEGO Minecraft Serie 1 Trading Card 134 - Neon Lohe - Mob Karte" (2026-11-24 probe).
    ebay: {
      queries: ['lego minecraft karten serie 1', 'lego minecraft tcc serie 1'],
      series: /\b(?:Series?|Staffel)\s*1\b|\bTCC\s*1\b/i,
    },
  },
};
