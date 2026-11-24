import type { CollectionDefinition } from './ids';

export const legoMinecraft1: CollectionDefinition<'lego-minecraft-1'> = {
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
    // "LEGO Minecraft Serie 1 Trading Card 134 - Neon Lohe - Mob Karte" (2026-11-24 probe).
    ebay: {
      queries: ['lego minecraft karten serie 1', 'lego minecraft tcc serie 1'],
      series: /\b(?:Series?|Staffel)\s*1\b|\bTCC\s*1\b/i,
    },
  },
};
