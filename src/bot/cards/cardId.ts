declare const cardIdBrand: unique symbol;
/**
 * A canonical card id (`12`, `LE8`, `XXL1`). Branded so a raw string cannot pass for one:
 * only this module creates them (normalizeCardId, parseCardList), and the database columns
 * holding card ids are typed with it (`.$type<CardId>()`).
 */
export type CardId = string & { readonly [cardIdBrand]: true };
export const CARD_TYPES = ['base', 'le', 'xxl'] as const;
export type CardType = (typeof CARD_TYPES)[number];

const MAX_RANGE_SIZE = 300;
const CARD_PATTERN = /^#?\s*(LE|XXL)?\s*(\d+)$/i;
const PLAIN_NUMBER_PATTERN = /^#?\s*\d+$/;

interface ParsedId {
  type: CardType;
  num: number;
}

const TYPE_ORDER: Record<CardType, number> = { base: 0, le: 1, xxl: 2 };
const PREFIX: Record<CardType, string> = { base: '', le: 'LE', xxl: 'XXL' };

/** The one place a string becomes a CardId. */
function toId(type: CardType, num: number): CardId {
  return `${PREFIX[type]}${num}` as CardId;
}

function parseId(raw: string): ParsedId | null {
  const match = CARD_PATTERN.exec(raw.trim());
  if (!match) return null;
  const [, rawPrefix, digits] = match;
  const num = Number.parseInt(digits ?? '', 10);
  if (!(num >= 1)) return null;
  const prefix = rawPrefix?.toUpperCase();
  return { type: prefix === 'LE' ? 'le' : prefix === 'XXL' ? 'xxl' : 'base', num };
}

/** Canonical form of a card id (`12`, `LE8`, `XXL1`), or null when `raw` is not a card id. */
export function normalizeCardId(raw: string): CardId | null {
  const parsed = parseId(raw);
  return parsed ? toId(parsed.type, parsed.num) : null;
}

/** Type of an already canonical card id. */
export function cardType(id: CardId): CardType {
  if (id.startsWith('LE')) return 'le';
  if (id.startsWith('XXL')) return 'xxl';
  return 'base';
}

function cardNumber(id: CardId): number {
  return Number.parseInt(id.replace(/^\D+/, ''), 10);
}

/** Sort order: base cards numerically, then LE, then XXL. */
export function compareCardIds(a: CardId, b: CardId): number {
  const byType = TYPE_ORDER[cardType(a)] - TYPE_ORDER[cardType(b)];
  return byType !== 0 ? byType : cardNumber(a) - cardNumber(b);
}

function parseToken(token: string): CardId[] | null {
  const single = normalizeCardId(token);
  if (single) return [single];

  const dash = token.indexOf('-');
  if (dash < 0) return null;
  const left = parseId(token.slice(0, dash));
  const rightRaw = token.slice(dash + 1);
  if (!left) return null;
  // `LE1-5` is shorthand for `LE1-LE5`: a bare number inherits the left prefix.
  const right =
    left.type !== 'base' && PLAIN_NUMBER_PATTERN.test(rightRaw.trim())
      ? parseId(`${PREFIX[left.type]}${rightRaw.replace('#', '')}`)
      : parseId(rightRaw);
  if (!right || right.type !== left.type || right.num < left.num) return null;
  if (right.num - left.num + 1 > MAX_RANGE_SIZE) return null;

  const ids: CardId[] = [];
  for (let n = left.num; n <= right.num; n++) ids.push(toId(left.type, n));
  return ids;
}

/**
 * Parse a comma separated list of ids and ranges. Valid ids come back deduped and
 * sorted; unparseable tokens come back, trimmed and in input order, in `invalid`.
 */
export function parseCardList(input: string): { ids: CardId[]; invalid: string[] } {
  const ids = new Set<CardId>();
  const invalid: string[] = [];
  for (const rawToken of input.split(',')) {
    const token = rawToken.trim();
    if (token === '') continue;
    const parsed = parseToken(token);
    if (parsed) {
      for (const id of parsed) ids.add(id);
    } else {
      invalid.push(token);
    }
  }
  return { ids: [...ids].sort(compareCardIds), invalid };
}

/** Sorted, deduped list with runs of two or more consecutive ids written as `a-b`. */
export function formatCardList(ids: CardId[]): string {
  const runs: CardId[][] = [];
  for (const id of [...new Set(ids)].sort(compareCardIds)) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (run && last && cardType(last) === cardType(id) && cardNumber(last) + 1 === cardNumber(id)) {
      run.push(id);
    } else {
      runs.push([id]);
    }
  }
  return runs
    .map((run) => (run.length > 1 ? `${run[0]}-${run.at(-1)}` : String(run[0])))
    .join(', ');
}
