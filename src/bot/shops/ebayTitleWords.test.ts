import { describe, expect, test } from 'bun:test';
import {
  COUNT_WORDS,
  MULTI_PICK_PATTERN,
  NOT_A_COUNT,
  NOT_AFTER_COUNT,
  wordsPattern,
} from './ebayTitleWords';

describe('shared eBay title words', () => {
  const card = new RegExp(`${NOT_AFTER_COUNT}#(\\d+)${NOT_A_COUNT}`);

  test('a number before a count word, sign or decimal is no card', () => {
    expect(card.exec('#5 Stück')).toBeNull();
    expect(card.exec('#5 Karten')).toBeNull();
    expect(card.exec('#5 €')).toBeNull();
    expect(card.exec('#5,50')).toBeNull();
    expect(card.exec('#5 Steve')?.[1]).toBe('5');
  });

  test('a count word matches only as a whole word, in any case', () => {
    const words = new RegExp(`^${wordsPattern(COUNT_WORDS)}`, 'i');
    expect(words.test('LOT')).toBe(true);
    expect(words.test('Lotus')).toBe(false);
  });

  test('pick lists are found, card names holding "pick" are not', () => {
    expect(MULTI_PICK_PATTERN.test('Einzelkarten zum Aussuchen')).toBe(true);
    expect(MULTI_PICK_PATTERN.test('Pick your card')).toBe(true);
    expect(MULTI_PICK_PATTERN.test('Diamond Pickaxe')).toBe(false);
  });
});
