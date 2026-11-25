declare const cardIdBrand: unique symbol;
/**
 * A canonical card id (`12`, `LE8`, `XXL1`, Turbo Attax `GG8`, `MR-HAM`). Branded so a raw
 * string cannot pass for one: only this module creates them (normalizeCardIdIn, parseCardList),
 * and the database columns
 * holding card ids are typed with it (`.$type<CardId>()`).
 */
export type CardId = string & { readonly [cardIdBrand]: true };
/**
 * `cards.type`, from LEGO Minecraft's kinds: `le` and `xxl` for those prefixes, everything else
 * `base` (Turbo Attax's other prefixes and relics too). Kept for the stored column; counts and
 * order use cardIdGroup, which serves every rule.
 */
export const CARD_TYPES = ['base', 'le', 'xxl'] as const;
export type CardType = (typeof CARD_TYPES)[number];

const MAX_RANGE_SIZE = 300;
const PLAIN_NUMBER_PATTERN = /^#?\s*\d+$/;
// `#12`, `le 8`, `#LE008`, `sun01`: an optional prefix, then a number.
const NUMBER_PATTERN = /^#?\s*([A-Za-z]*)\s*(\d+)$/;
// `MR-HAM`, `mr ham`, `MRHAM`: a two-letter family, then three letters.
const CODE_PATTERN = /^#?\s*([A-Za-z]{2})\s*[-\s]?\s*([A-Za-z]{3})$/;
// A canonical id: `12`, `LE8`, `MR-HAM`.
const CANONICAL_PATTERN = /^(?:([A-Z]+)(\d+)|(\d+)|([A-Z]{2})-([A-Z]{3}))$/;

/**
 * A collection's card id rule (CollectionDefinition.cardIds): which prefixes may stand before a
 * card number and which code families exist. An id outside a collection's rule is refused there
 * (`GG8` is no Minecraft card; `12` and `LE8` are ids of both), so a list or title is read only
 * with its own collection's rule.
 */
export interface CardIdRule {
  /** Letters before a card number, besides none (Minecraft `LE`, `XXL`). Uppercase. */
  readonly prefixes: readonly string[];
  /** Two-letter families of three-letter codes after a dash (Turbo Attax `MR`, `RR`). Uppercase. */
  readonly codes?: readonly string[];
}

/** LEGO Minecraft: `12`, `LE8`, `XXL1`. */
export const MINECRAFT_CARD_IDS: CardIdRule = { prefixes: ['LE', 'XXL'] };

/** Topps F1 Turbo Attax: `12`, `LE4`, `BG2`, `GG8`, `GU7`, `SUN1`, relics `MR-HAM`, `RR-ALB`. */
export const TURBO_ATTAX_CARD_IDS: CardIdRule = {
  prefixes: ['BG', 'GG', 'GU', 'LE', 'SUN'],
  codes: ['MR', 'RR'],
};

/** A numbered id: its prefix (`''` for a bare number) and number. */
interface NumberedId {
  prefix: string;
  num: number;
}

/** The one place a string becomes a CardId. */
function brand(id: string): CardId {
  return id as CardId;
}

function toId({ prefix, num }: NumberedId): CardId {
  return brand(`${prefix}${num}`);
}

function parseNumbered(rule: CardIdRule, raw: string): NumberedId | null {
  const match = NUMBER_PATTERN.exec(raw.trim());
  if (!match) return null;
  const prefix = (match[1] ?? '').toUpperCase();
  if (prefix !== '' && !rule.prefixes.includes(prefix)) return null;
  const num = Number.parseInt(match[2] ?? '', 10);
  return num >= 1 ? { prefix, num } : null;
}

function parseCode(rule: CardIdRule, raw: string): CardId | null {
  const match = CODE_PATTERN.exec(raw.trim());
  const family = match?.[1]?.toUpperCase();
  if (!match || family === undefined || !(rule.codes ?? []).includes(family)) return null;
  return brand(`${family}-${(match[2] ?? '').toUpperCase()}`);
}

/** Canonical form of a card id under `rule`, or null when `raw` is not one of its ids. */
export function normalizeCardIdIn(rule: CardIdRule, raw: string): CardId | null {
  const numbered = parseNumbered(rule, raw);
  return numbered ? toId(numbered) : parseCode(rule, raw);
}

/** Canonical form of a LEGO Minecraft card id (`12`, `LE8`, `XXL1`), or null. */
export function normalizeCardId(raw: string): CardId | null {
  return normalizeCardIdIn(MINECRAFT_CARD_IDS, raw);
}

/** Type of an already canonical card id: `LE` and `XXL` cards, everything else base. */
export function cardType(id: CardId): CardType {
  if (/^LE\d/.test(id)) return 'le';
  if (/^XXL\d/.test(id)) return 'xxl';
  return 'base';
}

/**
 * A canonical id's sort group (`''` for a bare number, the prefix, or the code family with its
 * dash) and number (null for a code).
 */
function sortKey(id: CardId): { group: string; num: number | null } {
  const m = CANONICAL_PATTERN.exec(id);
  if (!m) return { group: id, num: null };
  if (m[3] !== undefined) return { group: '', num: Number(m[3]) };
  if (m[1] !== undefined) return { group: m[1], num: Number(m[2]) };
  return { group: `${m[4]}-`, num: null };
}

/**
 * The group a canonical id is counted in: `base` for a bare number, else its prefix (`LE`, `GG`)
 * or code family with its dash (`MR-`).
 */
export function cardIdGroup(id: CardId): string {
  return sortKey(id).group || 'base';
}

/**
 * Sort order of every rule's ids: bare numbers numerically, then by prefix or code family
 * alphabetically (Minecraft: base, LE, XXL), numerically within a prefix, codes by their letters.
 */
export function compareCardIds(a: CardId, b: CardId): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  if (ka.group !== kb.group) {
    if (ka.group === '') return -1;
    if (kb.group === '') return 1;
    return ka.group < kb.group ? -1 : 1;
  }
  if (ka.num !== null && kb.num !== null && ka.num !== kb.num) return ka.num - kb.num;
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseToken(rule: CardIdRule, token: string): CardId[] | null {
  const single = normalizeCardIdIn(rule, token);
  if (single) return [single];

  const dash = token.indexOf('-');
  if (dash < 0) return null;
  const left = parseNumbered(rule, token.slice(0, dash));
  const rightRaw = token.slice(dash + 1);
  if (!left) return null;
  // `LE1-5` is shorthand for `LE1-LE5`: a bare number inherits the left prefix.
  const right =
    left.prefix !== '' && PLAIN_NUMBER_PATTERN.test(rightRaw.trim())
      ? parseNumbered(rule, `${left.prefix}${rightRaw.replace('#', '')}`)
      : parseNumbered(rule, rightRaw);
  if (!right || right.prefix !== left.prefix || right.num < left.num) return null;
  if (right.num - left.num + 1 > MAX_RANGE_SIZE) return null;

  const ids: CardId[] = [];
  for (let n = left.num; n <= right.num; n++) ids.push(toId({ prefix: left.prefix, num: n }));
  return ids;
}

/**
 * Parse a comma separated list of ids and ranges under the collection's `rule`. Valid ids come
 * back deduped and sorted; unparseable tokens come back, trimmed and in input order, in
 * `invalid`.
 */
export function parseCardList(
  input: string,
  rule: CardIdRule
): { ids: CardId[]; invalid: string[] } {
  const ids = new Set<CardId>();
  const invalid: string[] = [];
  for (const rawToken of input.split(',')) {
    const token = rawToken.trim();
    if (token === '') continue;
    const parsed = parseToken(rule, token);
    if (parsed) {
      for (const id of parsed) ids.add(id);
    } else {
      invalid.push(token);
    }
  }
  return { ids: [...ids].sort(compareCardIds), invalid };
}

/** Sorted, deduped list with runs of two or more consecutive ids written as `a-b`. */
export function formatCardList(ids: readonly CardId[]): string {
  const runs: CardId[][] = [];
  for (const id of [...new Set(ids)].sort(compareCardIds)) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    const key = sortKey(id);
    const lastKey = last === undefined ? null : sortKey(last);
    if (
      run &&
      lastKey &&
      lastKey.group === key.group &&
      lastKey.num !== null &&
      key.num === lastKey.num + 1
    ) {
      run.push(id);
    } else {
      runs.push([id]);
    }
  }
  return runs
    .map((run) => (run.length > 1 ? `${run[0]}-${run.at(-1)}` : String(run[0])))
    .join(', ');
}
