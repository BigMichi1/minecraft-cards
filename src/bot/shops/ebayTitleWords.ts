/**
 * The title words every eBay title reader shares (Minecraft's forms in ebay.ts, Turbo Attax's in
 * ebayTurboAttax.ts): counts, products, prices and pick lists, so a number before one is never
 * read as a card in any collection.
 */

export const LETTER = 'A-Za-zÄÖÜäöüß';

// A listing the buyer picks a card from: "zum aussuchen", "auswählen", "Auswahl", "du wählst",
// "waehlen". `pick` only as a whole word: "Pickaxe" is a card name.
export const MULTI_PICK_PATTERN = /aussuch|auswahl|w(?:ä|ae)hl|\bchoos|\bpick\b/i;

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
export const UNIT_WORDS = [
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
export const escapeRegExp = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const wordsPattern = (words: readonly string[]) =>
  `(?:${words.map(escapeRegExp).join('|')})(?![${LETTER}])`;
// The count signs that are not words: "2 €", "2-fach".
export const COUNT_SYMBOLS = `(?:€|-fach(?![${LETTER}]))`;
// After a number: not a decimal ("1,50", "1.50"), not a count sign, not a COUNT_WORDS word.
export const COUNT_AFTER = `(?!\\s*(?:${COUNT_SYMBOLS}|${wordsPattern(COUNT_WORDS)}))`;
export const NOT_A_COUNT = `(?![,.]\\d)${COUNT_AFTER}`;
// Before a number: "je 2", "2x 5", "2 x 5", "Stück 5" make it a count.
export const NOT_AFTER_COUNT = `(?<!(?:\\bje|\\d\\s*x|\\b${wordsPattern(UNIT_WORDS)})\\s*)`;
