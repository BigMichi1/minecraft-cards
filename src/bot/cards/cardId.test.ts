import { describe, expect, test } from 'bun:test';
import { cardType, compareCardIds, formatCardList, normalizeCardId, parseCardList } from './cardId';
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
