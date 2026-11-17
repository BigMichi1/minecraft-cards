import { describe, expect, test } from 'bun:test';
import { cardType } from './cardId';
import { parseChecklist, STARTER_CHECKLIST } from './starterCatalog';
import { ids } from '../../test/cardIds';

describe('parseChecklist', () => {
  test('drops the laststicker header line', () => {
    expect(parseChecklist('Prüfliste für Nummern diese Sammlung:\n1, 2, LE1, XXL1')).toEqual({
      ids: ids('1', '2', 'LE1', 'XXL1'),
      invalid: [],
    });
  });

  test('drops a header that arrives on the same line as the ids', () => {
    // Discord string options cannot hold newlines: a pasted checklist arrives on one line.
    expect(parseChecklist('Prüfliste für Nummern diese Sammlung: 1, 2, LE1, XXL1')).toEqual({
      ids: ids('1', '2', 'LE1', 'XXL1'),
      invalid: [],
    });
  });

  test('a colon after ids is not a header', () => {
    expect(parseChecklist('1, 2: 3').invalid).toEqual(['2: 3']);
  });

  test('parses the starter checklist into 251 cards', () => {
    const starter = parseChecklist(STARTER_CHECKLIST);
    expect(starter.invalid).toEqual([]);
    expect(starter.ids.length).toBe(251);
    expect(starter.ids.filter((id) => cardType(id) === 'le').length).toBe(22);
    expect(starter.ids.filter((id) => cardType(id) === 'xxl').length).toBe(1);
  });
});
