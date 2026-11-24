import { STARTER_CHECKLIST } from '../cards/starterCatalog';
import type { CollectionDefinition } from './ids';

export const legoMinecraft3: CollectionDefinition<'lego-minecraft-3'> = {
  id: 'lego-minecraft-3',
  name: 'LEGO Minecraft Serie 3 "On Fire"',
  starterChecklist: STARTER_CHECKLIST,
  laststicker: { set: 'blue_ocean_lego_minecraft_on_fire' },
};
