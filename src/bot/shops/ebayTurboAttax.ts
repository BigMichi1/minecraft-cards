import {
  compareCardIds,
  normalizeCardIdIn,
  TURBO_ATTAX_CARD_IDS,
  type CardId,
} from '../cards/cardId';
import logger from '../utils/logger';
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
 * Race numbers by surname: the 2026 drivers (and the numbers they raced with before) and the
 * legends of the set. Sellers write "Lewis Hamilton #44"; a number right beside its driver is
 * no card number, unless the catalog names that driver on that card ("Lando Norris #4").
 */
const RACE_NUMBERS: Readonly<Record<string, readonly number[]>> = {
  albon: [23],
  alonso: [14],
  antonelli: [12],
  barrichello: [11],
  bearman: [38, 50, 87],
  bortoleto: [5],
  bottas: [77],
  button: [1, 22],
  colapinto: [43],
  gasly: [10],
  hadjar: [6],
  hakkinen: [1],
  hamilton: [44],
  hill: [0, 1, 5],
  hulkenberg: [27],
  lawson: [30, 40],
  leclerc: [16],
  lindblad: [41],
  mansell: [2, 5],
  norris: [1, 4],
  ocon: [31],
  perez: [11],
  piastri: [81],
  prost: [1, 2],
  raikkonen: [7],
  rosberg: [1, 6],
  russell: [63],
  sainz: [55],
  schumacher: [1, 3, 5],
  stroll: [18],
  verstappen: [1, 3, 33],
  vettel: [1, 5],
  webber: [2],
};

/** Lowercase letters without accents ("Hülkenberg" as "hulkenberg"). */
const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// The word right before a number, past separators ("Hamilton #44", "Hamilton | #44"), and the
// word right after it ("#44 Hamilton").
const WORD_BEFORE = /([a-z]+)[\s|·•:,()\-–—]*$/;
const WORD_AFTER = /^[\s|·•:,()\-–—]*([a-z]+)/;

/**
 * The driver whose race number `n` stands right beside it in `title` (the number spanning
 * `start` to `end`), or null.
 */
function racingDriver(title: string, start: number, end: number, n: number): string | null {
  const before = WORD_BEFORE.exec(plain(title.slice(0, start)).replace(/#\s*$/, ''))?.[1];
  const after = WORD_AFTER.exec(plain(title.slice(end)))?.[1];
  for (const word of [before, after]) {
    if (word !== undefined && RACE_NUMBERS[word]?.includes(n)) return word;
  }
  return null;
}

/**
 * Card ids a Turbo Attax title names: `#N`, `Nr./No. N` (unless N is the race number of the
 * driver right beside it, and the catalog `names` do not name that driver on card N), a
 * prefixed number (`LE4`, `BG 2`, `#GG1`) and, in a relic's title, a relic code (`MR-VER`,
 * `MRSTE`), sorted and each once. Every number left out is logged at debug with its reason. The
 * caller has placed the title in Turbo Attax and excluded pick lists, ranges and parallels
 * (titleExclusion).
 */
export function readTurboAttaxCardIds(
  title: string,
  names: ReadonlyMap<CardId, string> = new Map()
): CardId[] {
  const ids = new Set<CardId>();
  const add = (raw: string) => {
    const id = normalizeCardIdIn(TURBO_ATTAX_CARD_IDS, raw);
    if (id) ids.add(id);
  };
  const dropped = (what: string, why: string) =>
    logger.debug(`eBay Turbo Attax: "${title.slice(0, 200)}": ${what} left out (${why})`);
  for (const m of title.matchAll(PREFIXED_PATTERN)) add(`${m[1]}${m[2]}`);
  const relicWord = RELIC_WORD.test(title);
  for (const m of title.matchAll(RELIC_PATTERN)) {
    if (relicWord) add(`${m[1]}-${m[2]}`);
    else dropped(`${m[1]}-${m[2]}`, 'no relic word in the title');
  }
  for (const m of title.matchAll(NUMBER_PATTERN)) {
    const n = Number(m[1]);
    const id = normalizeCardIdIn(TURBO_ATTAX_CARD_IDS, m[1] ?? '');
    const driver = racingDriver(title, m.index, m.index + m[0].length, n);
    if (driver !== null && !(id !== null && plain(names.get(id) ?? '').includes(driver))) {
      dropped(`#${n}`, `the race number of ${driver}`);
      continue;
    }
    add(m[1] ?? '');
  }
  return [...ids].sort(compareCardIds);
}

/** Whether a title names a number range in any Turbo Attax form: a choice, not stock. */
export function hasTurboAttaxRange(title: string): boolean {
  return RANGE_PATTERN.test(title);
}
