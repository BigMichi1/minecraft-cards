import { STARTER_CHECKLIST } from '../cards/starterCatalog';
import type { CollectionDefinition } from './ids';

export const legoMinecraft3: CollectionDefinition<'lego-minecraft-3'> = {
  id: 'lego-minecraft-3',
  name: 'LEGO Minecraft Serie 3 "On Fire"',
  starterChecklist: STARTER_CHECKLIST,
  laststicker: { set: 'blue_ocean_lego_minecraft_on_fire' },
  referenceFallbackShop: 'sammel-ente',
  // #59 and XXL1 show the same art: laststicker's #59 scan and sammel-ente's XXL1 picture (it has
  // no scan) score below TWIN_SIMILARITY, and a #59 picture is then decided as XXL1 (2026-11-24).
  knownTwins: [['59', 'XXL1']],
  shops: {
    'sammel-ente': { category: 'https://shop-sammel-ente.de/Minecraft/Serie-3/' },
    'blue-ocean': {},
    'collect-it': {
      category: 'https://www.collect-it.de/sammelkarten/lego/minecraft/serie-3/Einzelkarten',
      series: 'Serie 3',
    },
    ebay: {},
  },
};
