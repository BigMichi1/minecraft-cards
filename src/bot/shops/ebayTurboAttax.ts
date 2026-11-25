import {
  compareCardIds,
  normalizeCardIdIn,
  TURBO_ATTAX_CARD_IDS,
  type CardId,
} from '../cards/cardId';
import { LETTER, NOT_A_COUNT, NOT_AFTER_COUNT } from './ebayTitleWords';

/**
 * Turbo Attax's eBay title forms (spec "eBay", probe of 2026-11-25). Only forms that name a card
 * outright are read; a bare number (`Ferrari 8 Karten`, `237 - Carlos Sainz`), `Karte N` and
 * `Card N` (`Trading Card 2026`) never are: titles carry team numbers, counts and odds, and a
 * false id sends a false DM.
 */

const PREFIXES = TURBO_ATTAX_CARD_IDS.prefixes.join('|');
const CODES = (TURBO_ATTAX_CARD_IDS.codes ?? []).join('|');

// "LE4", "#LE6", "BG 2", "SUN 03", "#GG1": a prefix of the rule, a number of one or two digits,
// not glued to a word ("LE 24h").
const PREFIXED_PATTERN = new RegExp(
  `(?<![${LETTER}\\d])#?(${PREFIXES})\\s?(\\d{1,2})(?![\\d${LETTER}])${NOT_A_COUNT}`,
  'gi'
);
// A relic's title names it: only then are capitals read as a relic code.
const RELIC_WORD = /\brelic|\brelikt/i;
// "MR-VER", "MRSTE", "RR ALB": a relic family and three capital letters, not inside a word.
const RELIC_PATTERN = new RegExp(
  `(?<![${LETTER}\\d])(${CODES})[-\\s]?([A-Z]{3})(?![${LETTER}])`,
  'g'
);
// "#340", "# 16", "Nr. 12", "NO 264": a number sign or Nr./No., then one to three digits that
// are not a decimal, a count or a price.
const NUMBER_PATTERN = new RegExp(
  `${NOT_AFTER_COUNT}(?:#|\\b(?:Nr|No)\\.?)\\s*(\\d{1,3})(?![\\d,.])${NOT_A_COUNT}`,
  'gi'
);
// "#1 - 264", "(1-288)", "#136-150", "GG1-GG8", "LE 1 bis LE 18", "#1 to #264", "1~150":
// numbers in any Turbo Attax form joined by a dash, "bis", "to" or "~", in either order (a
// number before a dash is never a card here: "#288 - 150" is a choice as much as "#150 - 288").
const RANGE_PATTERN = new RegExp(
  `(?<![\\w/])#?(?:(?:${PREFIXES})\\s?)?\\d{1,3}\\s*(?:-|–|~|bis\\b|to\\b)\\s*#?(?:(?:${PREFIXES})\\s?)?\\d{1,3}(?!\\d)`,
  'i'
);

/**
 * The race numbers of the 2026 drivers (and the ones they raced with before), by surname: sellers
 * write "Lewis Hamilton #44", and a number beside its driver is no card number.
 */
const RACE_NUMBERS: Readonly<Record<string, readonly number[]>> = {
  albon: [23],
  alonso: [14],
  antonelli: [12],
  bearman: [38, 50, 87],
  bortoleto: [5],
  bottas: [77],
  colapinto: [43],
  gasly: [10],
  hadjar: [6],
  hamilton: [44],
  hulkenberg: [27],
  lawson: [30, 40],
  leclerc: [16],
  lindblad: [41],
  norris: [1, 4],
  ocon: [31],
  perez: [11],
  piastri: [81],
  russell: [63],
  sainz: [55],
  stroll: [18],
  verstappen: [1, 3, 33],
};

/** Lowercase letters without accents ("Hülkenberg" as "hulkenberg"). */
const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The race numbers of every driver a title names. */
function raceNumbersIn(title: string): Set<number> {
  const words = new Set(plain(title).match(/[a-z]+/g) ?? []);
  return new Set(Object.entries(RACE_NUMBERS).flatMap(([name, n]) => (words.has(name) ? n : [])));
}

/**
 * Card ids a Turbo Attax title names: `#N`, `Nr./No. N` (unless N is the race number of a driver
 * the title names), a prefixed number (`LE4`, `BG 2`, `#GG1`) and, in a relic's title, a relic
 * code (`MR-VER`, `MRSTE`), sorted and each once. The caller has placed the title in Turbo Attax
 * and excluded pick lists, ranges and parallels (titleExclusion).
 */
export function readTurboAttaxCardIds(title: string): CardId[] {
  const ids = new Set<CardId>();
  const add = (raw: string) => {
    const id = normalizeCardIdIn(TURBO_ATTAX_CARD_IDS, raw);
    if (id) ids.add(id);
  };
  for (const m of title.matchAll(PREFIXED_PATTERN)) add(`${m[1]}${m[2]}`);
  if (RELIC_WORD.test(title)) {
    for (const m of title.matchAll(RELIC_PATTERN)) add(`${m[1]}-${m[2]}`);
  }
  const raceNumbers = raceNumbersIn(title);
  for (const m of title.matchAll(NUMBER_PATTERN)) {
    if (!raceNumbers.has(Number(m[1]))) add(m[1] ?? '');
  }
  return [...ids].sort(compareCardIds);
}

/** Whether a title names a number range in any Turbo Attax form: a choice, not stock. */
export function hasTurboAttaxRange(title: string): boolean {
  return RANGE_PATTERN.test(title);
}
