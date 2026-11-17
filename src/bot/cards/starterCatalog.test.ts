import { describe, expect, test } from 'bun:test';
import { cardType } from './cardId';
import { parseChecklist, STARTER_CHECKLIST } from './starterCatalog';

describe('parseChecklist', () => {
  test('drops the laststicker header line', () => {
    expect(parseChecklist('Prüfliste für Nummern diese Sammlung:\n1, 2, LE1, XXL1')).toEqual({
      ids: ['1', '2', 'LE1', 'XXL1'],
      invalid: [],
    });
  });

  test('parses the starter checklist into 251 cards', () => {
    const starter = parseChecklist(STARTER_CHECKLIST);
    expect(starter.invalid).toEqual([]);
    expect(starter.ids.length).toBe(251);
    expect(starter.ids.filter((id) => cardType(id) === 'le').length).toBe(22);
    expect(starter.ids.filter((id) => cardType(id) === 'xxl').length).toBe(1);
  });
});
