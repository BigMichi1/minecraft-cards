import type { CollectionDefinition } from './ids';

export const legoMinecraft2: CollectionDefinition<'lego-minecraft-2'> = {
  id: 'lego-minecraft-2',
  name: 'LEGO Minecraft Serie 2 "TNT Boom-Bastic"',
  // laststicker has no scans of this set (2026-11-24: every picture URL answers 404), and lists
  // its one XXL card as a bare "XXL" (sammel-ente: #XXL001 Ghast).
  laststicker: {
    set: 'blue_ocean_lego_minecraft_tnt_boom_bastic',
    scans: false,
    numberAliases: { XXL: 'XXL1' },
  },
  referenceFallbackShop: 'sammel-ente',
  // collect-it has no series 2 single-card category (2026-11-24); blue-ocean's comes with PR 3c.
  shops: {
    'sammel-ente': {
      category: 'https://shop-sammel-ente.de/Minecraft/Serie-2/',
      series: 'Serie 2',
    },
    // Mostly category lots ("Sammelkarten Serie 2\"NETHER\""), a few "Boom-Bastic" singles.
    ebay: {
      queries: ['lego minecraft karten serie 2', 'lego minecraft boom bastic karte'],
      series: /\b(?:Series?|Staffel)\s*2\b|\bBoom[-\s]?Bastic\b/i,
    },
  },
};
