import { describe, expect, test } from 'bun:test';
import {
  cardIdGroup,
  cardType,
  compareCardIds,
  formatCardList,
  MINECRAFT_CARD_IDS,
  normalizeCardId,
  normalizeCardIdIn,
  parseCardList,
  TURBO_ATTAX_CARD_IDS,
} from './cardId';
import { cid, ids } from '../../test/cardIds';

describe('normalizeCardId', () => {
  test('accepts the supported spellings', () => {
    expect(normalizeCardId('12')).toBe(cid('12'));
    expect(normalizeCardId('012')).toBe(cid('12'));
    expect(normalizeCardId('#12')).toBe(cid('12'));
    expect(normalizeCardId('LE8')).toBe(cid('LE8'));
    expect(normalizeCardId('#LE008')).toBe(cid('LE8'));
    expect(normalizeCardId('le 8')).toBe(cid('LE8'));
    expect(normalizeCardId('XXL1')).toBe(cid('XXL1'));
  });

  test('rejects zero, empty and other text', () => {
    expect(normalizeCardId('0')).toBeNull();
    expect(normalizeCardId('000')).toBeNull();
    expect(normalizeCardId('LE0')).toBeNull();
    expect(normalizeCardId('')).toBeNull();
    expect(normalizeCardId('   ')).toBeNull();
    expect(normalizeCardId('foo')).toBeNull();
    expect(normalizeCardId('12a')).toBeNull();
    expect(normalizeCardId('1-2')).toBeNull();
  });
});

describe('cardType and compareCardIds', () => {
  test('classifies ids', () => {
    expect(cardType(cid('5'))).toBe('base');
    expect(cardType(cid('LE5'))).toBe('le');
    expect(cardType(cid('XXL1'))).toBe('xxl');
  });

  test('orders base, then LE, then XXL, numerically', () => {
    const sorted = ids('XXL1', 'LE10', 'LE2', '100', '9').sort(compareCardIds);
    expect(sorted).toEqual(ids('9', '100', 'LE2', 'LE10', 'XXL1'));
  });
});

describe('parseCardList', () => {
  test('parses a mixed list', () => {
    expect(parseCardList('#012, 12 , LE008, le 8, 20-22, LE1-LE2, xxl1, foo, 0, 25-20')).toEqual({
      ids: ids('12', '20', '21', '22', 'LE1', 'LE2', 'LE8', 'XXL1'),
      invalid: ['foo', '0', '25-20'],
    });
  });

  test('supports the LE1-3 shorthand', () => {
    expect(parseCardList('LE1-3').ids).toEqual(ids('LE1', 'LE2', 'LE3'));
  });

  test('rejects ranges over 300 ids but allows exactly 300', () => {
    expect(parseCardList('1-301').invalid).toEqual(['1-301']);
    expect(parseCardList('1-301').ids).toEqual([]);
    expect(parseCardList('1-300').ids.length).toBe(300);
  });

  test('rejects mixed-type ranges', () => {
    expect(parseCardList('5-LE3')).toEqual({ ids: [], invalid: ['5-LE3'] });
    expect(parseCardList('LE1-XXL2')).toEqual({ ids: [], invalid: ['LE1-XXL2'] });
  });

  test('handles empty input and empty segments', () => {
    expect(parseCardList('')).toEqual({ ids: [], invalid: [] });
    expect(parseCardList(' , ,1,')).toEqual({ ids: [cid('1')], invalid: [] });
  });
});

describe('formatCardList', () => {
  test('sorts and compresses consecutive runs', () => {
    expect(
      formatCardList([
        cid('5'),
        cid('1'),
        cid('2'),
        cid('3'),
        cid('12'),
        cid('LE2'),
        cid('LE1'),
        cid('XXL1'),
      ])
    ).toBe('1-3, 5, 12, LE1-LE2, XXL1');
  });

  test('compresses pairs and dedupes', () => {
    expect(formatCardList([cid('1'), cid('2'), cid('2')])).toBe('1-2');
    expect(formatCardList([])).toBe('');
  });
});

describe('card id rules', () => {
  test("each rule refuses the other's prefixes", () => {
    expect(normalizeCardIdIn(MINECRAFT_CARD_IDS, 'GG8')).toBeNull();
    expect(normalizeCardIdIn(MINECRAFT_CARD_IDS, 'MR-HAM')).toBeNull();
    expect(normalizeCardIdIn(TURBO_ATTAX_CARD_IDS, 'XXL1')).toBeNull();
    expect(normalizeCardIdIn(TURBO_ATTAX_CARD_IDS, 'MR-HAM')).toBe(cid('MR-HAM'));
    expect(normalizeCardIdIn(MINECRAFT_CARD_IDS, 'LE8')).toBe(cid('LE8'));
  });

  test('Turbo Attax forms', () => {
    const ta = (raw: string) => normalizeCardIdIn(TURBO_ATTAX_CARD_IDS, raw);
    expect(ta('LE 08')).toBe(cid('LE8'));
    expect(ta('sun01')).toBe(cid('SUN1'));
    expect(ta('#GG1')).toBe(cid('GG1'));
    expect(ta('bg 2')).toBe(cid('BG2'));
    expect(ta('GU11')).toBe(cid('GU11'));
    expect(ta('#0135')).toBe(cid('135'));
    expect(ta('mr-ham')).toBe(cid('MR-HAM'));
    expect(ta('MR HAM')).toBe(cid('MR-HAM'));
    expect(ta('RRALB')).toBe(cid('RR-ALB'));
    expect(ta('MR-HAMX')).toBeNull();
    expect(ta('MR-HA')).toBeNull();
    expect(ta('MR-1')).toBeNull();
    expect(ta('GG0')).toBeNull();
    expect(ta('XY5')).toBeNull();
  });

  test('parseCardList with a rule', () => {
    expect(parseCardList('1-3, GG1-2, mr-ham, LE 4', TURBO_ATTAX_CARD_IDS)).toEqual({
      ids: ids('1', '2', '3', 'GG1', 'GG2', 'LE4', 'MR-HAM'),
      invalid: [],
    });
    expect(parseCardList('LE1-LE3, SUN2-3', TURBO_ATTAX_CARD_IDS).ids).toEqual(
      ids('LE1', 'LE2', 'LE3', 'SUN2', 'SUN3')
    );
    expect(parseCardList('MR-HAM-MR-VER, GG1-LE2', TURBO_ATTAX_CARD_IDS)).toEqual({
      ids: [],
      invalid: ['MR-HAM-MR-VER', 'GG1-LE2'],
    });
    expect(parseCardList('GG1, XXL1').invalid).toEqual(['GG1']);
  });

  test('cardIdGroup names the prefix an id is counted under', () => {
    expect(ids('12', 'LE8', 'XXL1', 'GG8', 'MR-HAM').map(cardIdGroup)).toEqual([
      'base',
      'LE',
      'XXL',
      'GG',
      'MR-',
    ]);
  });

  test('compare and format across prefixes', () => {
    expect(
      formatCardList(ids('SUN2', '3', 'GG1', 'SUN1', 'MR-HAM', '1', '2', 'RR-ALB', 'BG1'))
    ).toBe('1-3, BG1, GG1, MR-HAM, RR-ALB, SUN1-SUN2');
    expect(ids('MR-VER', 'MR-HAM', 'LE2', '10').sort(compareCardIds)).toEqual(
      ids('10', 'LE2', 'MR-HAM', 'MR-VER')
    );
  });
});
