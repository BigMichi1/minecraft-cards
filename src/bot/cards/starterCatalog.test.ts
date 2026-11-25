import { describe, expect, test } from 'bun:test';
import { cardType, MINECRAFT_CARD_IDS, TURBO_ATTAX_CARD_IDS } from './cardId';
import { parseChecklist, STARTER_CHECKLIST } from './starterCatalog';
import { ids } from '../../test/cardIds';

describe('parseChecklist', () => {
  test("reads with the rule it is given, Minecraft's refusing Turbo Attax codes", () => {
    expect(parseChecklist('1, GG1, MR-HAM', TURBO_ATTAX_CARD_IDS)).toEqual({
      ids: ids('1', 'GG1', 'MR-HAM'),
      invalid: [],
    });
    expect(parseChecklist('1, GG1', MINECRAFT_CARD_IDS).invalid).toEqual(['GG1']);
  });

  test('drops the laststicker header line', () => {
    expect(
      parseChecklist('Prüfliste für Nummern diese Sammlung:\n1, 2, LE1, XXL1', MINECRAFT_CARD_IDS)
    ).toEqual({
      ids: ids('1', '2', 'LE1', 'XXL1'),
      invalid: [],
    });
  });

  test('drops a header that arrives on the same line as the ids', () => {
    // Discord string options cannot hold newlines: a pasted checklist arrives on one line.
    expect(
      parseChecklist('Prüfliste für Nummern diese Sammlung: 1, 2, LE1, XXL1', MINECRAFT_CARD_IDS)
    ).toEqual({
      ids: ids('1', '2', 'LE1', 'XXL1'),
      invalid: [],
    });
  });

  test('a colon after ids is not a header', () => {
    expect(parseChecklist('1, 2: 3', MINECRAFT_CARD_IDS).invalid).toEqual(['2: 3']);
  });

  test('parses the starter checklist into 251 cards', () => {
    const starter = parseChecklist(STARTER_CHECKLIST, MINECRAFT_CARD_IDS);
    expect(starter.invalid).toEqual([]);
    expect(starter.ids.length).toBe(251);
    expect(starter.ids.filter((id) => cardType(id) === 'le').length).toBe(22);
    expect(starter.ids.filter((id) => cardType(id) === 'xxl').length).toBe(1);
  });
});
