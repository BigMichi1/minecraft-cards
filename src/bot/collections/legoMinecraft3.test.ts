import { describe, expect, test } from 'bun:test';
import { STARTER_CHECKLIST } from '../cards/starterCatalog';
import { legoMinecraft3 } from './legoMinecraft3';

describe('legoMinecraft3', () => {
  test('is the series 3 collection', () => {
    expect(legoMinecraft3).toEqual({
      id: 'lego-minecraft-3',
      name: 'LEGO Minecraft Serie 3 "On Fire"',
      starterChecklist: STARTER_CHECKLIST,
    });
  });
});
