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
  // collect-it has no series 2 single-card category (2026-11-24).
  shops: {
    'sammel-ente': {
      category: 'https://shop-sammel-ente.de/Minecraft/Serie-2/',
      series: 'Serie 2',
    },
    // "Nummer 266 I Never trust this chef" (no series word), picture 266_lego_minecraft_tcc-02.jpg;
    // #1-9 at root URLs ("…-i-alex-00702502-01") (2026-11-24 probe).
    'blue-ocean': {
      categoryPath: 'trading-card-collection-boom-bastic',
      productCode: '00702502',
      picture: '_tcc-02',
      excludes: /\bTCC\s*2\b|\bBoom[-\s]?Bastic\b/i,
    },
    // Mostly category lots ("Sammelkarten Serie 2\"NETHER\""), a few "Boom-Bastic" singles.
    ebay: {
      queries: ['lego minecraft karten serie 2', 'lego minecraft boom bastic karte'],
      series: /\b(?:Series?|Staffel)\s*2\b|\bBoom[-\s]?Bastic\b/i,
    },
  },
};
