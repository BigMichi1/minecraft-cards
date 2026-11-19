import { compareCardIds, normalizeCardId } from '../cards/cardId';
import type { CardId } from '../cards/cardId';
import { errorMessage, sleep as realSleep } from '../utils/async';
import { REQUEST_TIMEOUT_MS, USER_AGENT, HttpError } from '../utils/http';
import logger from '../utils/logger';
import {
  ShopLayoutError,
  type AdapterOptions,
  type FetchFn,
  type FetchResult,
  type Listing,
  type Money,
  type ShopAdapter,
} from './types';

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const ITEM_URL = 'https://www.ebay.de/itm/';
const TOKEN_SAFETY_MARGIN_MS = 60_000;
/** Items per search page, the Browse API maximum. */
const SEARCH_LIMIT = 200;
/** Pages read per query: 1000 results. The broadest query had 295 on 2026-11-18. */
const MAX_PAGES_PER_QUERY = 5;
const PAGE_DELAY_MS = 1500;
/** eBay's `total` is an estimate: a walk may end this many items short (the larger of the two). */
const TOTAL_TOLERANCE_MIN = 5;
const TOTAL_TOLERANCE_SHARE = 0.02;
const tolerance = (total: number) =>
  Math.max(TOTAL_TOLERANCE_MIN, Math.ceil(total * TOTAL_TOLERANCE_SHARE));

export const EBAY_QUERIES = [
  'lego minecraft on fire karte',
  'lego minecraft tcc serie 3',
  'lego minecraft trading card on fire',
  // Most single cards ("LEGO Minecraft Karten 30 - Steve - Charakterkarte Serie 3 (2026)").
  'lego minecraft karten serie 3',
];

const LETTER = 'A-Za-zÄÖÜäöüß';
// "Serie 3", "Series 3", "Serie3", "On Fire".
const SERIES_3_PATTERN = /\bSeries?\s*3\b|\bOn\s*Fire\b/i;
// "Serie 1", "Series 2", but not "Serie 12".
const SERIES_1_2_PATTERN = /\bSeries?\s*[12]\b/i;
// A listing the buyer picks a card from: "zum aussuchen", "auswählen", "Auswahl", "du wählst",
// "waehlen". `pick` only as a whole word: "Pickaxe" is a card name.
const MULTI_PICK_PATTERN = /aussuch|auswahl|w(?:ä|ae)hl|\bchoos|\bpick\b/i;
// Not right after a series word: "Serie 3 - Steve" names the series, not card 3.
const NOT_AFTER_SERIES = '(?<!\\b(?:Serie|Series|Staffel)\\s*)';
// A number range: "1 - 228", "151-254", "LE1 - LE22", "1 bis 228". Only 1 to 3 digits, so
// "Serie 3 - 2026" (a year) is not one; the first number must be the smaller (see hasRange).
const RANGE_PATTERN = new RegExp(
  `${NOT_AFTER_SERIES}(?<![\\w/])(?:LE|XXL)?(\\d{1,3})\\s*(?:-|–|bis\\b)\\s*(?:LE|XXL)?(\\d{1,3})(?!\\d)`,
  'gi'
);

// Products and their plurals: never a card name, and a number right before one is a count
// ("3 Pack", "2 Boosters"), not a card number.
const PRODUCT_WORDS = [
  'Album',
  'Alben',
  'Blister',
  'Blisters',
  'Booster',
  'Boosters',
  'Box',
  'Boxen',
  'Bundle',
  'Bundles',
  'Cards',
  'Display',
  'Displays',
  'Foil',
  'Holo',
  'Karten',
  'Konvolut',
  'Lot',
  'Lots',
  'Mappe',
  'Mappen',
  'Multipack',
  'Multipacks',
  'Pack',
  'Packs',
  'Packung',
  'Packungen',
  'Paket',
  'Pakete',
  'Sammelkarte',
  'Sammelkarten',
  'Sammlung',
  'Set',
  'Sets',
  'Starter',
];
// Counts and units: "5 Stück", "2 St.", "3 Teile", "2 mal", "2 x".
const UNIT_WORDS = [
  'Exemplare',
  'fach',
  'mal',
  'pcs',
  'St.',
  'Stk',
  'Stück',
  'Stueck',
  'Teile',
  'weitere',
  'x',
];
// Prices and extras: "1 Euro", "2 EUR", "1 Karte gratis", "1 Karte dazu".
const PRICE_WORDS = ['dazu', 'EUR', 'Euro', 'gratis'];
// Seller slogans: "#1 Bestseller", "Nr. 1 Händler", "No. 1 Fan".
const SLOGAN_WORDS = ['Bestseller', 'Fan', 'Händler', 'Seller', 'Verkäufer'];

/**
 * The one shared list of words after which a number is a count, unit, price or slogan, never a
 * card id. Every number form checks it (NOT_A_COUNT): the prefixed list (`Karte 5 Stück`,
 * `#1 Bestseller`), LE/XXL (`XXL 1 Stück`), `NAME N Karte` (`Zombie 2 Karte gratis`), and the
 * dash form, whose name may not start with one (`5 - Stück - Charakterkarte`). A word added
 * here guards all of them; add it to the equality test in ebay.test.ts too.
 */
export const COUNT_WORDS: readonly string[] = [
  ...PRODUCT_WORDS,
  ...UNIT_WORDS,
  ...PRICE_WORDS,
  ...SLOGAN_WORDS,
];
const escapeRegExp = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordsPattern = (words: readonly string[]) =>
  `(?:${words.map(escapeRegExp).join('|')})(?![${LETTER}])`;
// The count signs that are not words: "2 €", "2-fach".
const COUNT_SYMBOLS = `(?:€|-fach(?![${LETTER}]))`;
// After a number: not a decimal ("1,50", "1.50"), not a count sign, not a COUNT_WORDS word.
const COUNT_AFTER = `(?!\\s*(?:${COUNT_SYMBOLS}|${wordsPattern(COUNT_WORDS)}))`;
const NOT_A_COUNT = `(?![,.]\\d)${COUNT_AFTER}`;
// Before a number: "je 2", "2x 5", "2 x 5", "Stück 5" make it a count.
const NOT_AFTER_COUNT = `(?<!(?:\\bje|\\d\\s*x|\\b${wordsPattern(UNIT_WORDS)})\\s*)`;

const LE_XXL_PATTERN = new RegExp(`\\b(LE|XXL)\\s?(\\d+)\\b${NOT_A_COUNT}`, 'gi');
// "12/228": only the series size counts, so dates (`11/2026`) and sizes (`10/12`) do not match.
const FRACTION_PATTERN = /\b(\d+)\s*\/\s*228\b/g;
const NOT_FOLLOWED_BY_WORD = '(?![\\dA-Za-zÄÖÜäöüß])';
// Every number of a list, the first included, must be a whole id, not a price or count
// ("3er Set", "3 weitere", "5 €", "1,50", "5 Stück").
const LIST_ITEM = `#?\\d+${NOT_FOLLOWED_BY_WORD}${NOT_A_COUNT}`;
// A prefix followed by a list: "#12, #45 und 107", "Nr. 12, 45", "Karte 12". "#1", "Nr. 1" or
// "No. 1" followed by "in" is a slogan ("Nr. 1 in Deutschland"); any other number before "in"
// stays a card ("Karte 12 in OVP", "#45 in Schutzhülle").
const SLOGAN_ONE_IN = `(?!(?<=(?:#|\\b(?:Nr|No)\\.?)\\s*0*1)\\s+in(?![${LETTER}]))`;
const PREFIXED_LIST_PATTERN = new RegExp(
  `(?:#|\\b(?:Nr|No)\\.?|\\b(?:Karte|Card))\\s*(\\d+${NOT_FOLLOWED_BY_WORD}${NOT_A_COUNT}${SLOGAN_ONE_IN}(?:(?:,\\s+|\\s*&\\s*|\\s+(?:und|and)\\s+)${LIST_ITEM})*)`,
  'gi'
);

/** The card types of series 3 titles, as the 2026-11-18 probe spelled them. */
const CARD_TYPES = ['Charakterkarte', 'Comickarte', 'Puzzlekarte', 'Setkarte'];
// Words a card name in the dash form never starts with: the shared count list and these.
const NOT_A_NAME_START = [
  ...COUNT_WORDS,
  'Doppel',
  'Doppelt',
  'Gold',
  'Goldkarte',
  'Karte',
  'Neu',
  'Neuware',
  'Rare',
];
// "Karten 30 - Steve - Charakterkarte", "Minecraft  132 - Wither Skeleton - Charakterkarte":
// a number (not after a count such as "je", "2x" or "Stück"), a spaced dash, a name not
// starting with a NOT_A_NAME_START word (a hyphen inside it, as in "End-Arena", is fine), a
// spaced dash and a known card type.
const NUMBER_NAME_TYPE_PATTERN = new RegExp(
  `${NOT_AFTER_SERIES}${NOT_AFTER_COUNT}(?:^|\\s)(\\d{1,3})\\s+[-–]\\s+(?!${COUNT_SYMBOLS}|${wordsPattern(NOT_A_NAME_START)})(?:(?!\\s[-–]\\s).)+?\\s+[-–]\\s+(?:${CARD_TYPES.join('|')})(?![${LETTER}])`,
  'gi'
);

/**
 * Card name words that may stand right before "N Karte" (`ULTRA RARE ZOMBIE 68 Karte`): the
 * characters and mobs of the series 3 card names in the 2026-11-18 probe. An allow-list, so a
 * pack or count word (`Booster 5 Karte`, `Holo 3 Karte`) never reads as a card number.
 *
 * To add a word: take it from the card's name in the catalog (the sammel-ente name, `/missing
 * status` shows it), never a pack, count or variant word; add it here and to the equality test
 * in ebay.test.ts; and add a real title using it to the fixture (src/test/fixtures/
 * ebay-search.json) with its reviewed ids.
 */
export const CARD_NAME_WORDS: readonly string[] = [
  'Adventurer',
  'Alex',
  'Armorsmith',
  'Bats',
  'Bear',
  'Bees',
  'Blaze',
  'Breeze',
  'Camel',
  'Cat',
  'Cow',
  'Creeper',
  'Cube',
  'Dragon',
  'Efe',
  'Enderman',
  'Ghast',
  'Handler',
  'Hoodie',
  'Horseman',
  'Husk',
  'Illager',
  'Knight',
  'Mooshroom',
  'Moobloom',
  'Ocelot',
  'Parrot',
  'Parrots',
  'Phantoms',
  'Piglin',
  'Piglins',
  'Pigs',
  'Pillager',
  'Rabbits',
  'Skeleton',
  'Slimes',
  'Sniffer',
  'Spiders',
  'Squid',
  'Steve',
  'Strider',
  'Sunny',
  'Tamer',
  'Villager',
  'Warden',
  'Warrior',
  'Witch',
  'Wither',
  'Wolf',
  'Zombie',
];
// "ZOMBIE 68 Karte", "VILLAGER 8 Card": a card name word, a number, then the singular "Karte"
// or "Card", not followed by a COUNT_WORDS word ("3 Card Pack", "2 Karte gratis", "2 Karte €").
// The plural ("6 Karten", "6 Cards") is a count.
const NAME_NUMBER_CARD_PATTERN = new RegExp(
  `(?<![${LETTER}\\d])(?:${CARD_NAME_WORDS.join('|')})\\s+(\\d{1,3})\\s+(?:Karte|Card)(?![${LETTER}])${COUNT_AFTER}`,
  'gi'
);

/** A range whose first number is below its second ("1 - 228"); "228 - 1 Stück" is not one. */
function hasRange(title: string): boolean {
  for (const m of title.matchAll(RANGE_PATTERN)) {
    if (Number(m[1]) < Number(m[2])) return true;
  }
  return false;
}

/**
 * Why a title gives no card ids by the title forms, whatever it names; see titleExclusion. Only
 * `no series 3` may still give ids, by catalog name (nameMatchedCardIds).
 */
export type TitleExclusion = 'other series' | 'no series 3' | 'pick list' | 'range';

/**
 * Why a title cannot name a series 3 card, or null when it can. It must name series 3
 * ("Serie 3", "On Fire") and no other series (a lot mixing series 1 or 2 is ambiguous; a title
 * without any series word may be series 1 or 2, which used the same title forms), and must not
 * be a listing to pick cards from or name a number range ("Einzelkarten 1 - 228 zum
 * aussuchen"): a range or a choice is not stock.
 */
export function titleExclusion(title: string): TitleExclusion | null {
  if (SERIES_1_2_PATTERN.test(title)) return 'other series';
  if (!SERIES_3_PATTERN.test(title)) return 'no series 3';
  if (MULTI_PICK_PATTERN.test(title)) return 'pick list';
  if (hasRange(title)) return 'range';
  return null;
}

/**
 * Card ids named in an eBay title, only for a title titleExclusion lets through. Prefixed forms
 * (`#12`, `Nr. 12`, `Karte 12`, `LE8`), `n/228`, `132 - Name - Charakterkarte` (also after
 * "Karten") and `ZOMBIE 68 Karte` (a card name word from CARD_NAME_WORDS) count; bare numbers
 * (`Serie 3`, `2026`) and counts (`6 Karten`) never do.
 */
export function extractCardIdsFromTitle(title: string): CardId[] {
  if (titleExclusion(title) !== null) return [];
  return readCardIds(title);
}

/** The card ids of the title forms extractCardIdsFromTitle reads, whatever the series. */
function readCardIds(title: string): CardId[] {
  const ids = new Set<CardId>();
  const add = (raw: string) => {
    const id = normalizeCardId(raw);
    if (id) ids.add(id);
  };
  for (const m of title.matchAll(LE_XXL_PATTERN)) add(`${m[1]}${m[2]}`);
  for (const m of title.matchAll(FRACTION_PATTERN)) add(m[1] ?? '');
  for (const m of title.matchAll(PREFIXED_LIST_PATTERN)) {
    for (const num of (m[1] ?? '').match(/\d+/g) ?? []) add(num);
  }
  for (const m of title.matchAll(NUMBER_NAME_TYPE_PATTERN)) add(m[1] ?? '');
  for (const m of title.matchAll(NAME_NUMBER_CARD_PATTERN)) add(m[1] ?? '');
  return [...ids].sort(compareCardIds);
}

// Any COUNT_WORDS word as a whole word: a pack, lot, count or price is never one single card.
const ANY_COUNT_WORD = new RegExp(`(?<![${LETTER}])${wordsPattern(COUNT_WORDS)}`, 'i');

// "LEGO Minecraft 131 - Ghast": a number before a spaced dash, not after the series, a count
// word or the LE/XXL prefix ("LE 19 - Creeper" is LE19) and not followed by a count. Read only
// for nameMatchedCardIds, where the catalog name beside it must confirm it.
const NUMBER_DASH_PATTERN = new RegExp(
  `${NOT_AFTER_SERIES}${NOT_AFTER_COUNT}(?<!\\b(?:LE|XXL)\\s*)(?:^|\\s)#?(\\d{1,3})\\s+[-–—]\\s+(?!${COUNT_SYMBOLS}|${wordsPattern(COUNT_WORDS)})`,
  'gi'
);

const SPACED_LE_XXL_PATTERN = new RegExp(
  `(?<![${LETTER}])(LE|XXL)\\s*(\\d+)(?!\\d)${NOT_A_COUNT}`,
  'gi'
);

/**
 * Title text for the name comparison: lowercase, umlauts and ß spelled out ("Wächterduell" and
 * "Waechterduell" alike), so the name check needs no Unicode case rules.
 */
function nameText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

/** A name's or title's letter and digit runs, in nameText form. */
const nameWords = (text: string): string[] => nameText(text).match(/[a-z\d]+/g) ?? [];

/** A card id as a (nameText) title writes it: `131`, `#131`, `0131`; `le8`, `le 08`, `le  8`. */
function cardIdPattern(id: CardId): string {
  const m = /^([A-Z]*)(\d+)$/.exec(id);
  if (!m) return escapeRegExp(nameText(id));
  const [, prefix = '', digits = ''] = m;
  const start = prefix ? `${nameText(prefix)}\\s*` : '';
  return `(?<![a-z\\d])${start}0*${digits}(?!\\d)`;
}

/**
 * A catalog name in a (nameText) title: its letter and digit runs in order, with any spaces or
 * punctuation between them ("Sunny vs. Blaze" also as "Sunny vs Blaze", "Ender-Knight" as
 * "ender knight"), but not glued together ("Sunny vsX Blaze"), and not part of a longer word.
 * Null for a name with no letter or digit.
 */
function cardNamePattern(name: string): string | null {
  const words = nameWords(name);
  return words.length > 0 ? `(?<![a-z\\d])${words.join('[^a-z\\d]+')}(?![a-z\\d])` : null;
}

// Between a number and its name: spaces, and at most one dash, colon or bar.
const BESIDE = '\\s*(?:[-–—:|]\\s*)?';
// Before a number its name may stand with a prefix: "Wither Skeleton Karte 4", "Karte #4".
const NUMBER_PREFIX = '(?:(?:nr\\.?|no\\.?|karte|card)\\s*)?(?:#\\s*)?';

/**
 * The only words a title read by name may hold besides its cards' numbers and names: the brand,
 * card words and types, rarity, condition, number prefixes and the series 3 year. An allow-list:
 * any other word may be another series ("Comic Steve", "Staffel 2", "S1"), another card's
 * longer name ("Gold Ghast", "Skeleton Horseman"), a second card ("Steve / Alex"), another
 * product ("Sticker", "Movie") or a year, and makes the title give nothing.
 */
export const NAME_TITLE_WORDS: readonly string[] = [
  '2026',
  'card',
  'common',
  'einzelkarte',
  'karte',
  'lego',
  'minecraft',
  'neu',
  'no',
  'nr',
  'ovp',
  'rare',
  'tcc',
  'tcg',
  'trading',
  'ultra',
  ...CARD_TYPES.map(nameText),
];
const NAME_TITLE_WORD_SET = new Set(NAME_TITLE_WORDS);

/**
 * Card ids of a title naming no series ("LEGO Minecraft Karte 131 - Ghast"), each confirmed by
 * its catalog name (`names`, the sammel-ente names) standing right beside its number: series 1
 * and 2 used the same title forms and numbers, so a number alone may be another series' card.
 * Only a title excluded for lacking a series word qualifies, and only without a pick list, range
 * or COUNT_WORDS word (so "Karten N - Name - Charakterkarte" never qualifies). Every number the
 * title forms (and `N - Name`, `LE  19`) read must carry its own name, and once those numbers
 * and names are taken out, nothing but NAME_TITLE_WORDS words and punctuation may be left:
 * "Comic Karte 3 - Steve", "Gold Ghast Karte 131" and "Karte 131 - Ghast 2025" give nothing.
 * "Karte 104 - Ghast" gives nothing too: series 3 #104 is not Ghast (#15 and #131 are). A
 * series 1 or 2 card sharing number and name still passes; its picture is compared as for every
 * title (docs/image-matching.md).
 */
export function nameMatchedCardIds(title: string, names: ReadonlyMap<CardId, string>): CardId[] {
  if (titleExclusion(title) !== 'no series 3') return [];
  if (MULTI_PICK_PATTERN.test(title) || hasRange(title) || ANY_COUNT_WORD.test(title)) return [];
  const candidates = new Set(readCardIds(title));
  for (const pattern of [NUMBER_DASH_PATTERN, SPACED_LE_XXL_PATTERN]) {
    for (const m of title.matchAll(pattern)) {
      const id = normalizeCardId(m[2] === undefined ? (m[1] ?? '') : `${m[1]}${m[2]}`);
      if (id) candidates.add(id);
    }
  }
  if (candidates.size === 0) return [];
  // Every card is looked for in the whole title, so their order does not matter; then all of
  // them are taken out at once, and only allowed words may be left.
  let rest = nameText(title);
  const spans: RegExp[] = [];
  for (const id of candidates) {
    const namePattern = cardNamePattern(names.get(id) ?? '');
    if (!namePattern) return [];
    const num = cardIdPattern(id);
    const beside = new RegExp(
      `${num}${BESIDE}${namePattern}|${namePattern}${BESIDE}${NUMBER_PREFIX}${num}`,
      'g'
    );
    if (!beside.test(rest)) return [];
    spans.push(beside);
  }
  for (const beside of spans) rest = rest.replace(beside, ' ');
  if (nameWords(rest).some((w) => !NAME_TITLE_WORD_SET.has(w))) return [];
  return [...candidates].sort(compareCardIds);
}

// The numbers a single-card title may carry without naming a card: the series ("Serie 3",
// "Series3") and a year ("2026").
const SERIES_OR_YEAR = /\b(?:Series?|Staffel)\s*\d+\b|\b(?:19|20)\d{2}\b/gi;

/**
 * Whether a title naming no card id may still offer one series 3 single card, so its picture
 * decides the card (docs/image-matching.md, rule 4): titleExclusion lets it through, and it has
 * no COUNT_WORDS word ("Booster", "Lot", "Karten", "Holo", "5 Stück") and no number but the
 * series and a year. A number the id patterns do not read is a count as often as a card
 * ("6 TradingCards ... 1 special Card"), so such a title is not left to the picture.
 */
export function isPictureCandidate(title: string): boolean {
  if (titleExclusion(title) !== null) return false;
  if (ANY_COUNT_WORD.test(title)) return false;
  return !/\d/.test(title.replace(SERIES_OR_YEAR, ' '));
}

interface EbayMoney {
  value?: string;
  currency?: string;
}

interface EbayItem {
  itemId?: string;
  legacyItemId?: string;
  title?: string;
  itemWebUrl?: string;
  image?: { imageUrl?: string };
  price?: EbayMoney;
  currentBidPrice?: EbayMoney;
  buyingOptions?: string[];
  shippingOptions?: { shippingCost?: EbayMoney }[];
  itemEndDate?: string;
  itemGroupType?: string;
}

/** "1.49" -> 149 without float arithmetic. */
function toCents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?\d*$/.exec(value.trim());
  if (!match) return null;
  return (
    Number.parseInt(match[1] ?? '0', 10) * 100 +
    Number.parseInt((match[2] ?? '').padEnd(2, '0') || '0', 10)
  );
}

function parseMoney(money: EbayMoney | undefined): Money | null {
  if (!money?.value || !money.currency) return null;
  const cents = toCents(money.value);
  return cents === null ? null : { cents, currency: money.currency };
}

function totalPrice(item: EbayItem, isAuction: boolean): Money | null {
  const base = parseMoney(isAuction ? (item.currentBidPrice ?? item.price) : item.price);
  if (!base) return null;
  const shipping = parseMoney(item.shippingOptions?.[0]?.shippingCost);
  if (shipping && shipping.currency === base.currency) {
    return { cents: base.cents + shipping.cents, currency: base.currency };
  }
  return base;
}

/**
 * The stable listing URL. `itemWebUrl` carries per-search tracking (`?hash=…&amdata=…`), so the
 * same item would get a new URL, a new row and a new notification on every search. The URL is
 * built from `legacyItemId`, else from the middle of `itemId` (`v1|<n>|<variation>`), else it is
 * `itemWebUrl` without its query string.
 */
function listingUrl(item: EbayItem): string | null {
  const legacy = item.legacyItemId ?? /^v1\|(\d+)\|/.exec(item.itemId ?? '')?.[1];
  if (legacy && /^\d+$/.test(legacy)) return `${ITEM_URL}${legacy}`;
  if (!item.itemWebUrl) return null;
  try {
    const url = new URL(item.itemWebUrl);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** `ids`: the title's card ids, or `picture` for a title naming none (isPictureCandidate). */
function toListing(item: EbayItem, url: string, title: string, ids: CardId[] | 'picture'): Listing {
  const isAuction = item.buyingOptions?.includes('AUCTION') ?? false;
  const endsAt = isAuction && item.itemEndDate ? Date.parse(item.itemEndDate) : Number.NaN;
  const fields = {
    shop: 'ebay' as const,
    url,
    title,
    cardName: null,
    imageUrl: item.image?.imageUrl ?? null,
    price: totalPrice(item, isAuction),
    available: true,
    format: isAuction ? ('auction' as const) : ('fixed_price' as const),
    auctionEndsAt: Number.isNaN(endsAt) ? null : endsAt,
    idConflict: false,
  };
  return ids === 'picture'
    ? { ...fields, idSource: 'picture', cardIds: [] }
    : { ...fields, cardIds: ids };
}

/** Shop-controlled text in a log line, clipped. */
const clip = (text: string) => (text.length > 200 ? `${text.slice(0, 200)}…` : text);

export function createEbayAdapter(
  opts: {
    clientId: string;
    clientSecret: string;
    fetchFn?: FetchFn;
    /**
     * The catalog's card names (sammel-ente's), read once per fetch: a title without a series
     * word counts only by a name beside its number (nameMatchedCardIds). Without it, such
     * titles stay excluded.
     */
    cardNames?: () => ReadonlyMap<CardId, string>;
  } & AdapterOptions
): ShopAdapter {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const delayMs = opts.delayMs ?? PAGE_DELAY_MS;
  const basicCredential = btoa(`${opts.clientId}:${opts.clientSecret}`);
  let token: { value: string; expiresAt: number } | null = null;

  /**
   * An error body without the client secret, the Basic credential or the access token in it.
   * An empty value is skipped: splitting on "" would put the marker between every character.
   */
  function redact(text: string): string {
    let out = text;
    for (const secret of [opts.clientSecret, basicCredential, token?.value]) {
      if (secret) out = out.split(secret).join('[redacted]');
    }
    return out;
  }

  /**
   * HttpError for a failed answer, with eBay's own error text: the `error`/`error_description`
   * of an OAuth answer or the messages of an API `errors` list, never other fields (a token
   * answer carries the access token); an answer with none of those gives its `message` or
   * `title`, else the names of its fields, never its values. A body that is not JSON is kept as
   * text; a JSON array or a JSON value that is not an object is named, not echoed.
   */
  async function failure(response: Response, url: string): Promise<HttpError> {
    const text = await response.text().catch(() => '');
    let detail = text;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: an HTML error page or plain text, kept as it is.
    }
    if (Array.isArray(json)) {
      detail = 'answer is a JSON array';
    } else if (typeof json === 'object' && json !== null) {
      const body = json as {
        error?: string;
        error_description?: string;
        message?: string;
        title?: string;
        errors?: { message?: string; longMessage?: string }[];
      };
      const parts = [
        body.error,
        body.error_description,
        ...(Array.isArray(body.errors) ? body.errors : []).map((e) =>
          [e?.longMessage, e?.message].find((part) => typeof part === 'string')
        ),
      ].filter((part): part is string => typeof part === 'string');
      if (parts.length === 0) {
        // A gateway or WAF answer: its message or title, else only the names of its fields.
        const note = [body.message, body.title].find((part) => typeof part === 'string');
        parts.push(note ?? `answer with fields: ${Object.keys(json).join(', ') || 'none'}`);
      }
      detail = parts.join('; ');
    } else if (json !== undefined) {
      detail = 'answer is JSON but not an object';
    }
    return new HttpError(response.status, url, redact(detail));
  }

  async function readJson<T>(response: Response, url: string): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new Error(`eBay answer from ${url} is not JSON: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  async function getToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value;
    const response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicCredential}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw await failure(response, TOKEN_URL);
    const body = await readJson<{ access_token?: string; expires_in?: number }>(
      response,
      TOKEN_URL
    );
    if (!body.access_token || typeof body.expires_in !== 'number') {
      throw new Error('eBay token response has no access_token/expires_in');
    }
    token = {
      value: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000 - TOKEN_SAFETY_MARGIN_MS,
    };
    return token.value;
  }

  /**
   * One page of a search; `pace` waits before every request but the first of a run. An answer
   * that is not an object, or whose `itemSummaries` is not a list of objects or whose `total`
   * is not a number, is a ShopLayoutError: eBay answered, but not with a search result.
   */
  async function searchPage(
    query: string,
    offset: number,
    pace: () => Promise<void>
  ): Promise<{ items: EbayItem[] | null; total: number | null }> {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}&offset=${offset}`;
    await pace();
    const response = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${await getToken()}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw await failure(response, url);
    const body = await readJson<unknown>(response, url);
    const shapeError = (what: string) =>
      new ShopLayoutError(
        `eBay search "${query}" offset ${offset}: unexpected answer shape (${what})`
      );
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw shapeError(body === null ? 'null' : Array.isArray(body) ? 'an array' : typeof body);
    }
    const { itemSummaries, total, errors } = body as Record<string, unknown>;
    if (total !== undefined && typeof total !== 'number') throw shapeError('total is not a number');
    if (itemSummaries === undefined) {
      const messages = (Array.isArray(errors) ? (errors as unknown[]) : []).map((e) => {
        const err = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
        return [err.longMessage, err.message].find((m) => typeof m === 'string') ?? '?';
      });
      if (messages.length > 0) {
        throw new Error(
          `eBay search "${query}" failed: ${redact(messages.join('; ')).slice(0, 300)}`
        );
      }
      return { items: null, total: total ?? null };
    }
    if (
      !Array.isArray(itemSummaries) ||
      !itemSummaries.every((i) => typeof i === 'object' && i !== null && !Array.isArray(i))
    ) {
      throw shapeError('itemSummaries is not a list of items');
    }
    return { items: itemSummaries as EbayItem[], total: total ?? null };
  }

  /**
   * A walk that ended with `read` items, below the announced total; `offset` is the last offset
   * requested (the empty page, the last page by the total, or the last page under the cap). eBay's
   * `total` is an estimate and its pages may hold fewer items than the limit, so a gap of at most
   * max(5, 2 % of the total) is accepted with a warning and no alert; a larger one is a
   * ShopLayoutError, as a partial walk would mark the unread listings unavailable.
   */
  function endShort(query: string, total: number, read: number, offset: number): void {
    const allowed = tolerance(total);
    if (total - read <= allowed) {
      logger.warn(
        `eBay search "${query}": total ${total}, but the walk ended at ${read} items; within the tolerance of ${allowed}, accepted`
      );
      return;
    }
    throw new ShopLayoutError(
      `eBay search "${query}": the walk ended at offset ${offset} with ${read} items read, but the total is ${total} (tolerance ${allowed})`
    );
  }

  /**
   * Every result of a search, page by page by `offset`, up to MAX_PAGES_PER_QUERY pages. eBay takes
   * only offsets that are a multiple of the limit, and a page may hold fewer items than the limit
   * before the end, so the offset is the page number times SEARCH_LIMIT, not the number of items
   * read, and a short page never ends a walk by itself. The walk ends at an empty page, or once the
   * next offset reaches the answer's total (a later page without a total keeps the earlier one);
   * the items read are then checked against the total (endShort). ShopLayoutErrors, as a partial
   * walk would mark the unread listings unavailable: a walk ending more than the tolerance below
   * the total (endShort), a walk at the cap reading more than tolerance(1000) = 20 fewer than 1000
   * items (the offsets it read hold that many, whatever eBay's estimate of the total), an empty
   * first page with a total above 0, and a first page with neither `itemSummaries` nor `total`. A
   * search cut at the cap (more announced than 1000 offsets reach, or no total at all) is logged
   * and added to `truncated`.
   */
  async function search(
    query: string,
    pace: () => Promise<void>,
    truncated: string[]
  ): Promise<EbayItem[]> {
    const all: EbayItem[] = [];
    let total: number | null = null;
    for (let page = 0; page < MAX_PAGES_PER_QUERY; page++) {
      const offset = page * SEARCH_LIMIT;
      const result = await searchPage(query, offset, pace);
      total = result.total ?? total;
      const items = result.items ?? [];
      all.push(...items);
      if (items.length === 0) {
        if (offset === 0 && result.items === null && result.total === null) {
          throw new ShopLayoutError(
            `eBay search "${query}" offset 0: answer has neither itemSummaries nor total`
          );
        }
        // The tolerance is for the end of a walk; an empty first page with a total is wrong.
        if (offset === 0 && total !== null && total > 0) {
          throw new ShopLayoutError(
            `eBay search "${query}" offset 0: empty page, but the total is ${total}`
          );
        }
        if (total !== null && total > all.length) endShort(query, total, all.length, offset);
        return all;
      }
      if (total !== null && offset + SEARCH_LIMIT >= total) {
        if (all.length < total) endShort(query, total, all.length, offset);
        return all;
      }
    }
    const lastOffset = (MAX_PAGES_PER_QUERY - 1) * SEARCH_LIMIT;
    if (total !== null) {
      // Only totals above the cap get here: every offset below it was read, so items missing
      // there are short pages, not the estimate. Their tolerance is that of the offsets read,
      // not of the total, or a large total would pass a partial walk as a cut one.
      const reach = MAX_PAGES_PER_QUERY * SEARCH_LIMIT;
      if (reach - all.length > tolerance(reach)) {
        throw new ShopLayoutError(
          `eBay search "${query}": the walk ended at offset ${lastOffset} with ${all.length} items read of the first ${reach}, total ${total} (tolerance ${tolerance(reach)})`
        );
      }
      // Within the tolerance of the total: complete as far as eBay's estimate goes.
      if (total - all.length <= tolerance(total)) {
        endShort(query, total, all.length, lastOffset);
        return all;
      }
    }
    const note = `search "${query}": ${total ?? 'more'} results, only the first ${all.length} read (${MAX_PAGES_PER_QUERY}-page cap)`;
    logger.warn(`eBay ${note}`);
    truncated.push(note);
    return all;
  }

  return {
    id: 'ebay',
    async fetchListings(): Promise<FetchResult> {
      const names = opts.cardNames?.() ?? new Map<CardId, string>();
      const byUrl = new Map<string, Listing>();
      const noId = new Set<string>();
      const excluded = new Set<string>();
      // Invalid items by item id: every search returning the same item counts it once.
      const invalid = new Set<string>();
      const truncated: string[] = [];
      let itemsSeen = 0;
      let requests = 0;
      // 1500 ms between two search requests, as between two pages of a shop.
      const pace = async () => {
        if (requests++ > 0) await sleep(delayMs);
      };
      for (const query of EBAY_QUERIES) {
        const items = await search(query, pace, truncated);
        itemsSeen += items.length;
        for (const item of items) {
          const url = listingUrl(item);
          const title = item.title;
          if (!url || !title) {
            // Without any id, the item's own JSON: the same item from two searches is equal.
            invalid.add(
              item.itemId ?? item.legacyItemId ?? item.itemWebUrl ?? JSON.stringify(item)
            );
            continue;
          }
          if (byUrl.has(url) || noId.has(url) || excluded.has(url)) continue;
          // A listing with variations (`SELLER_DEFINED_VARIATIONS`) sells a choice of cards
          // under one title; which of them is in stock is not in the search answer.
          const reason = item.itemGroupType ? 'variations' : titleExclusion(title);
          const byName = reason === 'no series 3' ? nameMatchedCardIds(title, names) : [];
          if (byName.length > 0) {
            logger.debug(
              `eBay: "${clip(title)}" names no series, read by catalog name as ${byName.join(', ')}`
            );
            byUrl.set(url, toListing(item, url, title, byName));
            continue;
          }
          if (reason) {
            excluded.add(url);
            logger.debug(`eBay: skipped "${clip(title)}" (${reason})`);
            continue;
          }
          const cardIds = extractCardIdsFromTitle(title);
          if (cardIds.length === 0 && isPictureCandidate(title)) {
            // No card id, but one single card: passed on without ids for the picture to decide.
            byUrl.set(url, toListing(item, url, title, 'picture'));
            continue;
          }
          if (cardIds.length === 0) {
            noId.add(url);
            logger.debug(`eBay: skipped "${clip(title)}" (no card id)`);
            continue;
          }
          byUrl.set(url, toListing(item, url, title, cardIds));
        }
      }
      // Same rule as the shops: an answer with nothing in it is an API or query problem,
      // and must not mark every stored eBay listing unavailable.
      if (itemsSeen === 0) {
        throw new ShopLayoutError(`eBay: all ${EBAY_QUERIES.length} searches returned no items`);
      }
      return {
        listings: [...byUrl.values()],
        skippedNoId: noId.size,
        skippedExcluded: excluded.size,
        skippedInvalid: invalid.size,
        ...(truncated.length > 0 ? { truncated } : {}),
      };
    },
  };
}
