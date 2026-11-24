import type { CollectionDefinition } from './ids';

export const legoMinecraft1: CollectionDefinition<'lego-minecraft-1'> = {
  id: 'lego-minecraft-1',
  name: 'LEGO Minecraft Serie 1',
  laststicker: { set: 'blue_ocean_lego_minecraft-1' },
  referenceFallbackShop: 'sammel-ente',
  shops: {
    'sammel-ente': { category: 'https://shop-sammel-ente.de/Minecraft/Serie-1/' },
    'collect-it': {
      category:
        'https://www.collect-it.de/sammelwelt/sammelkarten/lego/minecraft/serie1/Einzelkarten',
      series: 'Serie 1',
    },
  },
};
