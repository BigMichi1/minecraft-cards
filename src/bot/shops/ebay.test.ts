import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
import type { CollectionId } from '../collections/ids';
import {
  CARD_NAME_WORDS,
  COUNT_WORDS,
  createEbayFetcher,
  extractCardIdsFromTitle,
  isPictureCandidate,
  NAME_TITLE_WORDS,
  nameMatchedCardIds,
  classifyTitle,
  EBAY_COLLECTIONS,
  titleExclusion,
  EBAY_QUERIES,
} from './ebay';

/** The fetcher tests read the series 3 fixture: series 3's searches and markers only. */
const SERIES_3_ONLY = EBAY_COLLECTIONS.filter((c) => c.id === 'lego-minecraft-3');
const S3_QUERIES = SERIES_3_ONLY[0]!.queries;
/** Series 1's and 2's card lists, loaded, with no name series 3 has at the same number. */
const OTHER_SERIES_NAMES = new Map([[cid('250'), 'Platzhalter']]);
/** Catalog names: `names` for series 3, OTHER_SERIES_NAMES for the other series. */
const s3Names =
  (names: ReadonlyMap<CardId, string>) =>
  (c: CollectionId): ReadonlyMap<CardId, string> =>
    c === 'lego-minecraft-3' ? names : OTHER_SERIES_NAMES;
import type { CardId } from '../cards/cardId';
import { HttpError } from '../utils/http';
import { parseSammelEntePage } from './sammelEnte';
import { readFixture } from '../../test/shopHelpers';
import { ShopLayoutError, type FetchFn } from './types';
import { cid, ids } from '../../test/cardIds';

/** A title marked as series 3, so only the id patterns are under test. */
const s3 = (title: string) => extractCardIdsFromTitle(`On Fire ${title}`);

interface FixtureItem {
  itemId: string;
  legacyItemId?: string;
  title: string;
}
const fixtureItems = (
  JSON.parse(readFixture('ebay-search.json')) as { itemSummaries: FixtureItem[] }
).itemSummaries;

/**
 * Reviewed ids of every item in the fixture (real titles from 2026-11-18, plus five made-up
 * ones with 1100000000xx ids). Every item must be listed, so a new fixture item gets reviewed.
 */
const FIXTURE_IDS: Record<string, string[]> = {
  // Made up.
  '110000000001': ['12'],
  '110000000002': ['12', '45', 'LE8'],
  '110000000003': ['107'],
  '110000000004': [],
  '110000000005': ['107'],
  // "Karten N - Name - Type ... Serie 3".
  '307033154225': ['1'],
  '298464547193': ['6'],
  '820220708310': ['12'],
  '307033238089': ['13'],
  '307033164852': ['81'],
  '306904746510': ['154'],
  '298266919445': ['190'],
  '298464913981': ['210'],
  '307033129412': ['226'],
  // "Minecraft  N - Name - Charakterkarte ... Serie 3".
  '307033237331': ['59'],
  '298266882310': ['85'],
  // "NAME N Karte".
  '880079740087': ['68'],
  '880120413461': ['8'],
  // Limited cards.
  '880127012180': ['LE21'],
  '880113389508': ['LE22'],
  '318738930910': ['LE12'],
  '298542435874': ['LE1'],
  '307151001820': ['LE16'],
  // A blister sold with its named limited card.
  '318920506278': ['LE16'],
  // "Nr41".
  '336881714628': ['41'],
  // Packs, counts, a name without a number.
  '237167730326': [],
  '318113529715': [],
  '257656279927': [],
  '168243696252': [],
  '318793648300': [],
  '306898657124': [],
  '336881691966': [],
  // Multi-pick listings and ranges.
  '298476153721': [],
  '820220677540': [],
  '960043845055': [],
  '277849229105': [],
  '336833205199': [],
  // Series 1 and 2.
  '296375051309': [],
  '296375051455': [],
  '305536785803': [],
  '315605969936': [],
  '366399742152': [],
  // No series word.
  '294036373907': [],
};

/**
 * The fixture items without ids whose title passes every single-card check, so the picture
 * decides their card (rule 4, docs/image-matching.md). Reviewed by hand.
 */
const FIXTURE_CANDIDATES = new Set(['336881691966']);

const fixtureKey = (item: FixtureItem) =>
  item.legacyItemId ?? /^v1\|(\d+)\|/.exec(item.itemId)?.[1] ?? item.itemId;

describe('extractCardIdsFromTitle', () => {
  test('reads prefixed numbers', () => {
    expect(extractCardIdsFromTitle('LEGO Minecraft On Fire Karte Nr. 12 Squid')).toEqual([
      cid('12'),
    ]);
    expect(s3('Karte Nr.12')).toEqual([cid('12')]);
    expect(s3('Card No. 7')).toEqual([cid('7')]);
    expect(s3('Karte 012')).toEqual([cid('12')]);
    expect(s3('Card 5')).toEqual([cid('5')]);
  });

  test('keeps a card number followed by "in" (only "#1" / "Nr. 1" / "No. 1 in" is a slogan)', () => {
    expect(s3('Karte 12 in OVP')).toEqual([cid('12')]);
    expect(s3('#45 in Schutzhülle')).toEqual([cid('45')]);
    expect(s3('Nr. 12 in Top Zustand')).toEqual([cid('12')]);
    expect(s3('Karte 12 in Sleeve')).toEqual([cid('12')]);
    expect(s3('Karte 1 in OVP')).toEqual([cid('1')]);
  });

  test('reads no card number from a count of Sammelkarten', () => {
    expect(s3('Karte 2 Sammelkarten')).toEqual([]);
    expect(s3('Karte 2 Sammelkarte')).toEqual([]);
  });

  test('reads bundles, LE and XXL ids', () => {
    expect(extractCardIdsFromTitle('Lego Minecraft TCC Serie 3 #12, #45 und LE8')).toEqual(
      ids('12', '45', 'LE8')
    );
    expect(s3('LE 08 und XXL1')).toEqual(ids('LE8', 'XXL1'));
    expect(s3('Nr. 12, 45 und 107')).toEqual(ids('12', '45', '107'));
  });

  test('takes the card number of a 12/228 title and ignores bare numbers', () => {
    expect(extractCardIdsFromTitle('Minecraft Serie 3 Karte 107/228 2026')).toEqual([cid('107')]);
    expect(s3('Squid 12/228')).toEqual([cid('12')]);
    expect(extractCardIdsFromTitle('LEGO Minecraft Serie 3 Booster 2026')).toEqual([]);
    expect(s3('Sammlung 228 Karten')).toEqual([]);
  });

  test('prices, counts and sizes after a prefix are not ids', () => {
    // A price is not a card number (round 2, F1).
    expect(s3('Karte 1,50 €')).toEqual([]);
    expect(s3('Nr. 12, 3er Set')).toEqual([cid('12')]);
    expect(s3('Karte 12 und 3 weitere')).toEqual([cid('12')]);
    expect(s3('Karte 3er Set')).toEqual([]);
    expect(s3('Nr. 1er')).toEqual([]);
    expect(s3('11/2026 neu')).toEqual([]);
    expect(s3('Größe 10/12')).toEqual([]);
  });

  test('dedupes and sorts', () => {
    expect(s3('LE8 #45 #12 Nr. 12')).toEqual(ids('12', '45', 'LE8'));
  });

  test('reads "Karten N - Name" and "N - Name - Typkarte"', () => {
    expect(
      extractCardIdsFromTitle('LEGO Minecraft Karten 30 - Steve - Charakterkarte Serie 3 (2026)')
    ).toEqual([cid('30')]);
    expect(
      extractCardIdsFromTitle(
        'LEGO Minecraft Karten 226 - Vernetzungstreffen - Comickarte Serie 3 (2026)'
      )
    ).toEqual([cid('226')]);
    expect(s3('Karten 7 – Shadow Hoodie - Charakterkarte')).toEqual([cid('7')]);
    // A hyphen inside the name is not the spaced dash.
    expect(
      extractCardIdsFromTitle('LEGO Minecraft Karten 193 - Die End-Arena - Setkarte Serie 3 (2026)')
    ).toEqual([cid('193')]);
    expect(
      extractCardIdsFromTitle(
        'LEGO Minecraft Karten 198 - Das Lava-Duell im Nether - Setkarte Serie 3 (2026)'
      )
    ).toEqual([cid('198')]);
    // Without a known card type the dash form is not read: a miss, not a false id.
    expect(s3('Karten 7 – Shadow Hoodie')).toEqual([]);
    expect(s3('Karten 7 - Shadow Hoodie - Einzelkarte')).toEqual([]);
    expect(
      extractCardIdsFromTitle(
        'LEGO Minecraft  132 - Wither Skeleton - Charakterkarte - Holo Serie 3 (2026)'
      )
    ).toEqual([cid('132')]);
    expect(s3('Karten 12')).toEqual([]);
    expect(s3('111 Karten - neuwertig')).toEqual([]);
  });

  test('reads a number directly before Karte or Card, but not counts', () => {
    expect(
      extractCardIdsFromTitle(
        'LEGO MINECRAFT ON FIRE Serie 3 ULTRA RARE ZOMBIE 68 Karte Trading Card'
      )
    ).toEqual([cid('68')]);
    expect(s3('Villager 8 Card')).toEqual([cid('8')]);
    expect(s3('Blue Ocean Trading Cards 21 Packs à 6 Karten Creeper')).toEqual([]);
    expect(s3('193 verschiedene Karten')).toEqual([]);
    expect(s3('6 Karten')).toEqual([]);
    expect(s3('6 Cards')).toEqual([]);
    expect(s3('incl. 1 special Card')).toEqual([]);
    expect(s3('inkl 1 Karte')).toEqual([]);
    expect(s3('plus 2 Karte')).toEqual([]);
    // The series number is not a card number.
    expect(extractCardIdsFromTitle('LEGO Minecraft Serie 3 Karte #107 Auktion')).toEqual([
      cid('107'),
    ]);
    expect(extractCardIdsFromTitle('LEGO Minecraft Series 3 Card')).toEqual([]);
  });

  test('the first number after a prefix is checked for counts and prices too (F1)', () => {
    for (const title of [
      'On Fire Karte 5 Stück',
      'On Fire Karte 2 x',
      'On Fire Karte 2 €',
      'On Fire Karte 2€',
      'On Fire Karte 1 Euro',
      'On Fire Karte 10 Stk',
      'On Fire Karte 1 Stueck',
      'On Fire Card 2 Pack',
      'On Fire Card 3 pcs',
      'On Fire #1 Bestseller',
      'On Fire Nr. 1 Händler',
      'On Fire Karte 2 EUR',
      'On Fire Karte 1.50',
    ]) {
      expect({ title, ids: extractCardIdsFromTitle(title) }).toEqual({ title, ids: [] });
    }
    expect(s3('Karte 12, 3 Karten')).toEqual([cid('12')]);
    expect(s3('Karte 12, 3 Cards')).toEqual([cid('12')]);
    // Still read: a card number followed by its name or a card word.
    expect(s3('Karte 12 Squid')).toEqual([cid('12')]);
    expect(s3('#12 Karte')).toEqual([cid('12')]);
    expect(s3('Karte 12 XXL1')).toEqual(ids('12', 'XXL1'));
  });

  test('a number before Karte/Card followed by a product word is not read (F2)', () => {
    for (const title of [
      'On Fire Zombie 2 Karte gratis',
      'On Fire Wolf 3 Card Pack',
      'On Fire Creeper 10 Card Lot',
      'On Fire Steve 4 Karte dazu',
    ]) {
      expect({ title, ids: extractCardIdsFromTitle(title) }).toEqual({ title, ids: [] });
    }
    expect(s3('ULTRA RARE ZOMBIE 68 Karte Trading Card')).toEqual([cid('68')]);
  });

  test('the dash form refuses more name words and a number after je or x (F3)', () => {
    for (const word of ['Neu', 'Rare', 'Gold', 'Doppel', 'Karte', 'Sammelkarten']) {
      const title = `On Fire 5 - ${word} - Charakterkarte`;
      expect({ title, ids: extractCardIdsFromTitle(title) }).toEqual({ title, ids: [] });
    }
    for (const title of [
      'On Fire je 2 - Steve - Charakterkarte',
      'On Fire x 2 - Steve - Charakterkarte',
    ]) {
      expect({ title, ids: extractCardIdsFromTitle(title) }).toEqual({ title, ids: [] });
    }
    expect(s3('Karten 2 - Steve - Charakterkarte')).toEqual([cid('2')]);
  });

  test('LE and XXL followed by a count are not ids (F4)', () => {
    for (const title of [
      'On Fire LE 3 Karten',
      'On Fire XXL 2 Stück',
      'On Fire XXL 1 Stück',
      'On Fire LE8 x',
    ]) {
      expect({ title, ids: extractCardIdsFromTitle(title) }).toEqual({ title, ids: [] });
    }
    expect(s3('LE21 Karte Card')).toEqual([cid('LE21')]);
    expect(s3('XXL1 Steve')).toEqual([cid('XXL1')]);
  });

  // prettier-ignore
  const EXPECTED_COUNT_WORDS = [
    // Products and their plurals.
    'Album', 'Alben', 'Blister', 'Blisters', 'Booster', 'Boosters', 'Box', 'Boxen', 'Bundle',
    'Bundles', 'Cards', 'Display', 'Displays', 'Foil', 'Holo', 'Karten', 'Konvolut', 'Lot',
    'Lots', 'Mappe', 'Mappen', 'Multipack', 'Multipacks', 'Pack', 'Packs', 'Packung',
    'Packungen', 'Paket', 'Pakete', 'Sammelkarte', 'Sammelkarten', 'Sammlung', 'Set', 'Sets',
    'Starter',
    // Counts and units.
    'Exemplare', 'fach', 'mal', 'pcs', 'St.', 'Stk', 'Stück', 'Stueck', 'Teile', 'weitere', 'x',
    // Prices.
    'dazu', 'EUR', 'Euro', 'gratis',
    // Seller slogans.
    'Bestseller', 'Fan', 'Händler', 'Seller', 'Verkäufer',
  ];

  test('one shared count list guards every number form (structural, F5, G1-G4)', () => {
    expect(COUNT_WORDS).toEqual(EXPECTED_COUNT_WORDS);
    // The symbols and joined forms that are not words.
    const extras = ['€', '-fach'];
    for (const word of [...COUNT_WORDS, ...extras]) {
      const cases = /^[A-Za-zÄÖÜäöüß.]+$/.test(word)
        ? [word, word.toUpperCase(), word.toLowerCase()]
        : [word];
      for (const w of cases) {
        const sep = w === '-fach' ? '' : ' ';
        for (const title of [
          `On Fire Karte 5${sep}${w}`,
          `On Fire Card 5${sep}${w}`,
          `On Fire #5${sep}${w}`,
          `On Fire Nr. 5${sep}${w}`,
          `On Fire No. 5${sep}${w}`,
          `On Fire Karte 12, 5${sep}${w}`,
          `On Fire LE5${sep}${w}`,
          `On Fire LE 5${sep}${w}`,
          `On Fire XXL1${sep}${w}`,
          `On Fire XXL 1${sep}${w}`,
          `On Fire Zombie 5 Karte${sep}${w}`,
          `On Fire Zombie 5 Card${sep}${w}`,
          `On Fire Karten 5 - ${w} Steve - Charakterkarte`,
        ]) {
          const got = extractCardIdsFromTitle(title).filter((id) => id !== '12');
          expect({ title, ids: got }).toEqual({ title, ids: [] });
        }
      }
    }
  });

  test('the cases named in round 3 give no id (G1-G4)', () => {
    for (const title of [
      // G1
      'On Fire Zombie 2 Card Stueck',
      'On Fire Zombie 2 Karte x',
      'On Fire Zombie 2 Karte Euro',
      'On Fire Zombie 2 Karte €',
      // G2
      'On Fire Karte 2 St.',
      'On Fire Karte 2 Teile',
      'On Fire Karte 2 Exemplare',
      'On Fire Karte 2 mal',
      'On Fire Karte 2 fach',
      'On Fire Karte 2-fach',
      'On Fire Karte 2 Boosters',
      'On Fire Karte 2 Packungen',
      'On Fire LE 2 Boosters',
      'On Fire XXL 1 Teile',
      // G3
      'On Fire #1 Verkäufer',
      'On Fire Nr. 1 Seller',
      'On Fire No. 1 Fan',
      'On Fire Nr 1 in Deutschland',
      'On Fire #1 in Deutschland',
      'On Fire No. 1 in Germany',
      // G4
      'On Fire 5 - Stueck - Charakterkarte',
      'On Fire 5 - Sammelkarte - Charakterkarte',
      'On Fire 5 - Doppelt - Charakterkarte',
      'On Fire 5 - Neuware - Charakterkarte',
      'On Fire 5 - Goldkarte - Charakterkarte',
      'On Fire 2x 5 - Steve - Charakterkarte',
      'On Fire 2 x 5 - Steve - Charakterkarte',
      'On Fire Stück 5 - Steve - Charakterkarte',
      'On Fire Stk 5 - Steve - Charakterkarte',
    ]) {
      expect({ title, ids: extractCardIdsFromTitle(title) }).toEqual({ title, ids: [] });
    }
    // Still read.
    expect(s3('#12 Squid')).toEqual([cid('12')]);
    expect(s3('Nr. 12 Steve')).toEqual([cid('12')]);
    expect(s3('Karte 12 Steve')).toEqual([cid('12')]);
    expect(s3('Karten 5 - Steve - Charakterkarte')).toEqual([cid('5')]);
    expect(s3('ZOMBIE 68 Karte Trading Card')).toEqual([cid('68')]);
  });

  test('the dash forms refuse counts, product words and the series number (E2)', () => {
    for (const title of [
      'Serie 3 Karten 2 - Booster - Sammelkarte',
      'On Fire Karten 10 – Lot',
      'On Fire Karten 3 - Pack Booster',
      'On Fire 10 - Booster Pack - Sammelkarte',
      'On Fire Display 24 - Booster - Sammelkarte',
      'LEGO Minecraft Serie 3 - Steve - Charakterkarte',
      'LEGO Minecraft Series 3 - Steve - Charakterkarte',
      'LEGO Minecraft Staffel 3 - Steve - Charakterkarte On Fire',
      'On Fire 3 - Holo - Sammelkarte',
      'On Fire 3 - Holo - Charakterkarte',
      'On Fire Karten 4 - Booster Pack - Charakterkarte',
      'On Fire Karten 5 - Stück - Comickarte',
      'On Fire Karten 6 - Set Steve - Setkarte',
      'On Fire Karten 7 - Konvolut - Puzzlekarte',
      'On Fire 8 - Display - Charakterkarte',
      'On Fire 9 - Paket - Charakterkarte',
      'On Fire 11 - Album - Charakterkarte',
    ]) {
      expect({ title, ids: extractCardIdsFromTitle(title) }).toEqual({ title, ids: [] });
    }
  });

  test('a number before Karte counts only after a known card name (E1)', () => {
    for (const title of [
      'LEGO Minecraft On Fire XXL 3 Karte',
      'Serie 3 Booster 1 Karte gratis',
      'On Fire Album 1 Karte LE',
      'Serie 3 neu 2 Karte',
      'On Fire Holo 3 Karte',
      'On Fire Tausch 3 Karte',
      'On Fire Booster 5 Karte',
      'On Fire Holo 1 Karte',
    ]) {
      const got = extractCardIdsFromTitle(title).filter((id) => /^\d+$/.test(id));
      expect({ title, ids: got }).toEqual({ title, ids: [] });
    }
    const notNames = [
      'Booster',
      'Pack',
      'Holo',
      'Foil',
      'Neu',
      'Album',
      'Mappe',
      'Tausch',
      'LE',
      'XXL',
      'Serie',
      'Series',
      'Staffel',
      'mit',
      'je',
      'nur',
      'set',
      'lot',
      'x',
      'ca',
      'plus',
      'inkl',
      'incl',
      'und',
      'and',
      'Fire',
      'Rare',
      'Ultra',
      'Gold',
      'Edition',
      'Limited',
      'Karten',
      'Cards',
      'Trading',
      'Display',
      'Blister',
      'Lego',
      'Minecraft',
    ];
    for (const word of notNames) {
      for (const w of [word, word.toUpperCase()]) {
        const title = `On Fire ${w} 3 Karte`;
        const got = extractCardIdsFromTitle(title).filter((id) => /^\d+$/.test(id));
        expect({ title, ids: got }).toEqual({ title, ids: [] });
      }
    }
    // The allow-list is pinned, so a change to it is deliberate, and every word in it reads.
    expect(CARD_NAME_WORDS).toEqual(
      // prettier-ignore
      [
        'Adventurer', 'Alex', 'Armorsmith', 'Bats', 'Bear', 'Bees', 'Blaze', 'Breeze', 'Camel',
        'Cat', 'Cow', 'Creeper', 'Cube', 'Dragon', 'Efe', 'Enderman', 'Ghast', 'Handler', 'Hoodie',
        'Horseman', 'Husk', 'Illager', 'Knight', 'Mooshroom', 'Moobloom', 'Ocelot', 'Parrot',
        'Parrots', 'Phantoms', 'Piglin', 'Piglins', 'Pigs', 'Pillager', 'Rabbits', 'Skeleton',
        'Slimes', 'Sniffer', 'Spiders', 'Squid', 'Steve', 'Strider', 'Sunny', 'Tamer', 'Villager',
        'Warden', 'Warrior', 'Witch', 'Wither', 'Wolf', 'Zombie',
      ]
    );
    for (const word of CARD_NAME_WORDS) {
      for (const w of [word, word.toUpperCase()]) {
        const title = `LEGO MINECRAFT ON FIRE Serie 3 ${w} 68 Karte`;
        expect({ title, ids: extractCardIdsFromTitle(title) }).toEqual({ title, ids: [cid('68')] });
      }
    }
    // "Karte 3 Karte" is the "Karte N" prefix form, so "Karte" is checked here only.
    for (const word of [...notNames, 'Karte', 'Card']) {
      expect(CARD_NAME_WORDS.map((w) => w.toLowerCase())).not.toContain(word.toLowerCase());
    }
  });

  test('titles ending in a year or a count after a dash keep their ids (E3)', () => {
    expect(
      extractCardIdsFromTitle('LEGO Minecraft Karten 30 - Steve - Charakterkarte Serie 3 - 2026')
    ).toEqual([cid('30')]);
    expect(s3('Karte 107/228 - 1 Stück')).toEqual([cid('107')]);
    // A real range still excludes the title.
    expect(s3('Karte #12 1 - 228')).toEqual([]);
    expect(s3('Karte #12 12-24')).toEqual([]);
  });

  test('only titles that name series 3 give ids', () => {
    expect(extractCardIdsFromTitle('LEGO Minecraft Serie 3 Karte #12')).toEqual([cid('12')]);
    expect(extractCardIdsFromTitle('LEGO Minecraft Series 3 Karte #12')).toEqual([cid('12')]);
    expect(extractCardIdsFromTitle('LEGO Minecraft Serie3 Karte #12')).toEqual([cid('12')]);
    expect(extractCardIdsFromTitle('LEGO Minecraft ON FIRE Karte #12')).toEqual([cid('12')]);
    // Series 1 and 2 used the same title forms: without a series word, no ids.
    expect(extractCardIdsFromTitle('LEGO Minecraft Karten 30 - Steve - Charakterkarte')).toEqual(
      []
    );
    expect(extractCardIdsFromTitle('LEGO Minecraft Karte #12 LE8')).toEqual([]);
    expect(extractCardIdsFromTitle('Minecraft Trading Cards 2021 - Nr. 215 Foil Karte')).toEqual(
      []
    );
  });

  test('titles naming series 1 or 2 give no ids, even with series 3 in them', () => {
    expect(
      extractCardIdsFromTitle('LEGO Minecraft Serie 1 Trading Card 3 - Comic Steve - Skin Karte')
    ).toEqual([]);
    expect(extractCardIdsFromTitle('Lego Minecraft Sammelkarten Serie 2 LE8')).toEqual([]);
    expect(extractCardIdsFromTitle('Lego Minecraft Serie 2 und Serie 3 Karte #12, #45')).toEqual(
      []
    );
    expect(extractCardIdsFromTitle('LEGO Minecraft On Fire Series 1 Card 5')).toEqual([]);
    // "Serie 12" is not series 1.
    expect(extractCardIdsFromTitle('On Fire Karte #12 Serie 12')).toEqual([cid('12')]);
  });

  test('multi-pick listings and ranges give no ids', () => {
    expect(
      extractCardIdsFromTitle(
        'LEGO Minecraft Serie 3 Trading Cards Einzelkarten 1 - 228 zum aussuchen choose'
      )
    ).toEqual([]);
    expect(s3('Karte #12 zum Aussuchen')).toEqual([]);
    expect(s3('Karte #12 auswählen')).toEqual([]);
    expect(s3('Karte #12 Auswahl')).toEqual([]);
    expect(s3('Karte #12 du wählst')).toEqual([]);
    expect(s3('Karte #12 choose')).toEqual([]);
    expect(s3('Karte #12 pick')).toEqual([]);
    expect(s3('Karte #12 wählen')).toEqual([]);
    expect(s3('Karte #12 waehlen')).toEqual([]);
    expect(s3('Karte #12 bitte auswählen')).toEqual([]);
    expect(s3('Karte #12 bitte auswaehlen')).toEqual([]);
    // Card names starting with "pick" are not a pick list (T1).
    expect(s3('Karte #12 Diamond Pickaxe')).toEqual([cid('12')]);
    expect(s3('Karte #12 Picker')).toEqual([cid('12')]);
    expect(s3('Karte #12 151-254')).toEqual([]);
    expect(s3('LE1 - LE22')).toEqual([]);
    expect(s3('Karte #12, Karten 1 bis 228')).toEqual([]);
  });

  test('titleExclusion names the reason a title gives no ids', () => {
    expect(titleExclusion('LEGO Minecraft Karten 30 - Steve - Charakterkarte Serie 3')).toBeNull();
    expect(titleExclusion('LEGO Minecraft Serie 1 Karte 3')).toBe('other series');
    expect(titleExclusion('LEGO Minecraft Karte 3')).toBe('no series');
    expect(titleExclusion('Lego Minecraft Serie 2 und Serie 3 Karte #12')).toBe(
      'several collections'
    );
    expect(titleExclusion('LEGO Minecraft Serie 1 Karte 3', 'lego-minecraft-1')).toBeNull();
    expect(titleExclusion('On Fire Karte 3 zum aussuchen')).toBe('pick list');
    expect(titleExclusion('On Fire Karten 1 - 228')).toBe('range');
  });

  test('every fixture title gives its reviewed ids', () => {
    const seen = new Set<string>();
    for (const item of fixtureItems) {
      const key = fixtureKey(item);
      seen.add(key);
      expect({ key, title: item.title, ids: extractCardIdsFromTitle(item.title) }).toEqual({
        key,
        title: item.title,
        ids: FIXTURE_IDS[key] as never,
      });
    }
    expect([...seen].sort()).toEqual(Object.keys(FIXTURE_IDS).sort());
  });
});

describe('nameMatchedCardIds', () => {
  // Series 3 names as laststicker and sammel-ente give them (2026-11-24): Ghast is #15, #102,
  // #104 and #131; #103 is Zombie. Entries marked otherwise exercise title forms.
  const names = new Map([
    [cid('15'), 'Ghast'],
    [cid('131'), 'Ghast'],
    [cid('104'), 'Ghast'],
    [cid('103'), 'Zombie'],
    [cid('4'), 'Wither Skeleton'],
    [cid('2'), 'Ender Knight'],
    [cid('LE8'), 'Charged Creeper'],
    // Names whose words are part of other cards' names.
    [cid('3'), 'Steve'],
    [cid('5'), 'Creeper'],
    [cid('13'), 'Skeleton'],
    [cid('41'), 'Skeleton Horseman'],
    [cid('LE19'), 'Creeper'],
    [cid('LE21'), 'Gold Ghast'],
    [cid('XXL1'), 'Charged Creeper'],
    // sammel-ente's puzzle names of 2026-11-18 (laststicker: "The Overworld 1", "... 2").
    [cid('154'), 'Puzzlekarte Oberwelt 1'],
    [cid('155'), 'Puzzlekarte Oberwelt 2'],
    [cid('6'), 'Zombie'],
    [cid('12'), 'Squid'],
    [cid('14'), 'Alex'],
    [cid('1'), 'Alex'],
    [cid('29'), 'Burning Zombie'],
    // Made up, for the "vs." and umlaut forms.
    [cid('200'), 'Sunny vs. Blaze'],
    [cid('201'), 'Das Wächterduell'],
  ]);

  test('a title without a series word gives the number whose catalog name stands beside it', () => {
    expect(nameMatchedCardIds('LEGO Minecraft Karte 131 - Ghast', names)).toEqual(ids('131'));
    expect(nameMatchedCardIds('Lego Minecraft Karte 15 Ghast', names)).toEqual(ids('15'));
    expect(nameMatchedCardIds('LEGO Minecraft Nr. 104 Ghast', names)).toEqual(ids('104'));
    expect(nameMatchedCardIds('LEGO Minecraft 131 - Ghast', names)).toEqual(ids('131'));
    expect(nameMatchedCardIds('Minecraft 4 - Wither Skeleton - Charakterkarte', names)).toEqual(
      ids('4')
    );
    expect(nameMatchedCardIds('LEGO Minecraft #002: ender-knight', names)).toEqual(ids('2'));
    expect(nameMatchedCardIds('LEGO Minecraft Wither Skeleton Karte 4', names)).toEqual(ids('4'));
    expect(nameMatchedCardIds('LEGO Minecraft LE8 Charged Creeper', names)).toEqual(ids('LE8'));
  });

  test('a number whose catalog name is another one gives nothing', () => {
    // Series 3 #103 is Zombie; #16 (Team Wolf Skin and Wolf Tamer) is not in the map.
    expect(nameMatchedCardIds('LEGO Minecraft Karte 103 - Ghast', names)).toEqual([]);
    expect(nameMatchedCardIds('LEGO Minecraft Karte 16 - Ghast', names)).toEqual([]);
    // The name elsewhere in the title, not beside the number, does not count.
    expect(nameMatchedCardIds('LEGO Minecraft Zombie Ultra Rare Karte 103', names)).toEqual([]);
    expect(nameMatchedCardIds('LEGO Minecraft Karte 103 Ultra Rare Zombie', names)).toEqual([]);
    expect(nameMatchedCardIds('LEGO Minecraft Karte 103 Zombie', names)).toEqual(ids('103'));
    expect(nameMatchedCardIds('LEGO Minecraft Karte 131 - Ghasty', names)).toEqual([]);
  });

  test('a name several series 3 cards share confirms the number it stands beside', () => {
    // The listing of 2026-11-19 that PR #22 meant to exclude: series 3 #104 is Ghast too, so it
    // reads as #104, and only the picture comparison checks it. Whether such a title is series 3
    // at all is decided against the series 1 and 2 names once those catalogs exist.
    expect(nameMatchedCardIds('LEGO Minecraft Karte 104 - Ghast', names)).toEqual(ids('104'));
  });

  test('every number read must carry its own name, or none counts', () => {
    expect(
      nameMatchedCardIds('LEGO Minecraft Karte 131 - Ghast & Karte 103 - Ghast', names)
    ).toEqual([]);
    expect(nameMatchedCardIds('LEGO Minecraft Karte 131 - Ghast, Karte 15 - Ghast', names)).toEqual(
      ids('15', '131')
    );
  });

  test('only a title excluded for lacking a series word qualifies', () => {
    for (const title of [
      'LEGO Minecraft Serie 3 Karte 131 - Ghast', // has ids by the title rules already
      'LEGO Minecraft Serie 1 Karte 131 - Ghast',
      'LEGO Minecraft Karte 131 - Ghast zum aussuchen',
      'LEGO Minecraft Karten 1 - 228 131 - Ghast',
      'LEGO Minecraft 131 Karten - Ghast',
      'LEGO Minecraft Karte 131 - Ghast 3 Stück',
      'LEGO Minecraft Nr. 104 Ghast Holo', // any COUNT_WORDS word, as for picture candidates
    ]) {
      expect({ title, ids: nameMatchedCardIds(title, names) }).toEqual({ title, ids: [] });
    }
  });

  test('no names, or no number, gives nothing', () => {
    expect(nameMatchedCardIds('LEGO Minecraft Karte 131 - Ghast', new Map())).toEqual([]);
    expect(nameMatchedCardIds('LEGO Minecraft Ghast', names)).toEqual([]);
    // A blank stored name confirms nothing.
    expect(
      nameMatchedCardIds('LEGO Minecraft Karte 131 -  ', new Map([[cid('131'), '  ']]))
    ).toEqual([]);
  });

  const check = (cases: [string, CardId[]][]) => {
    for (const [title, expected] of cases) {
      expect({ title, ids: nameMatchedCardIds(title, names) }).toEqual({ title, ids: expected });
    }
  };

  test('any other series or product line word gives nothing', () => {
    check([
      ['LEGO Minecraft Staffel 1 Karte 15 Ghast', []],
      ['LEGO Minecraft Staffel 2 Karte 131 - Ghast', []],
      ['LEGO Minecraft Serie 4 Karte 15 Ghast', []],
      ['LEGO Minecraft Serie II Karte 131 Ghast', []],
      ['LEGO Minecraft Karte 131 Ghast 1. Serie', []],
      ['LEGO Minecraft Season 1 Karte 15 Ghast', []],
      ['LEGO Minecraft S1 Karte 15 Ghast', []],
      ['Panini Minecraft Karte 15 Ghast', []],
      ['LEGO Minecraft Dungeons Karte 15 Ghast', []],
      // Products that are no cards.
      ['Minecraft Sticker Nr. 5 Creeper', []],
      ['Minecraft Figur Nr. 5 Creeper', []],
      ['LEGO Minecraft Karte 1 Alex - Minecraft Movie', []],
      ['LEGO Minecraft Karte 1 Alex Film', []],
    ]);
  });

  test('any number besides its cards and the year 2026 gives nothing', () => {
    check([
      ['LEGO Minecraft 2021 Karte 15 Ghast', []],
      ['LEGO Minecraft Karte 131 Ghast 2025', []],
      ['LEGO Minecraft (2021) Karte 15 Ghast', []],
      // A second card without its name: not one single #15.
      ['LEGO Minecraft Karte 15 Ghast 131 Ghast', []],
      ['LEGO Minecraft Karte 15 Ghast und 131', []],
      ['LEGO Minecraft Karte 131 - Ghast 2026', ids('131')],
    ]);
  });

  test('several cards: each by its own name, in either order, joined by a separator', () => {
    check([
      ['LEGO Minecraft Karte 1 - Alex & Karte 14 - Alex', ids('1', '14')],
      ['LEGO Minecraft Karte 1 Alex + Karte 14 Alex', ids('1', '14')],
      // Each card beside its own name, in whichever order.
      ['LEGO Minecraft Steve Karte 3 Ghast Karte 15', ids('3', '15')],
      ['LEGO Minecraft Ghast Karte 15 Steve Karte 3', ids('3', '15')],
      // The same card twice is still that card.
      ['LEGO Minecraft Karte 15 - Ghast Karte 15 - Ghast', ids('15')],
      // A second card named without its number: not one single #3.
      ['LEGO Minecraft Karte 3 - Steve / Alex', []],
      ['LEGO Minecraft Creeper 5 - Zombie', []],
    ]);
  });

  test('the allowed words are the reviewed list', () => {
    // An allow-list: adding a word lets more titles through, so it is a reviewed change.
    expect([...NAME_TITLE_WORDS].sort()).toEqual(
      [
        '2026',
        'card',
        'charakterkarte',
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
      ].sort()
    );
  });

  test('any word left beside the cards but the allowed ones gives nothing', () => {
    check([
      // Series 1 card 3 is "Comic Steve"; its qualifier may stand anywhere.
      ['LEGO Minecraft Comic Karte 3 - Steve', []],
      ['Comic #3 Steve', []],
      ['LEGO Minecraft Karte 3 - Steve - Comic', []],
      ['LEGO Minecraft Karte 3 Steve (Comic)', []],
      ['Comic: Steve Karte 3', []],
      ['LEGO Minecraft Trading Card 3 - Steve - Skin Karte', []],
      ['LEGO Minecraft Karte 3 - Steve - Pokemon', []],
      ['LEGO Minecraft Karte 3 - Steve - Proxy', []],
      // The qualifier as one card type word.
      ['LEGO Minecraft Comickarte 3 - Steve', []],
      ['LEGO Minecraft Karte 3 - Steve - Comickarte', []],
      ['LEGO Minecraft Karte 3 - Steve Comickarte', []],
      ['Minecraft Puzzlekarte 3 - Steve', []],
      // Only NAME_TITLE_WORDS words and punctuation remain: accepted.
      ['LEGO Minecraft Trading Card 3 - Steve - Charakterkarte Ultra Rare NEU OVP 2026', ids('3')],
    ]);
  });

  test("a name that is part of another card's longer name gives nothing", () => {
    check([
      // Series 1 card 3 is "Comic Steve"; series 3 #3 is "Steve".
      ['LEGO Minecraft Comic Steve Karte 3', []],
      ['LEGO Minecraft Karte 3 Steve Comic Skin', []],
      // LE21 is "Gold Ghast".
      ['LEGO Minecraft Gold Ghast Karte 131', []],
      ['LEGO Minecraft Karte 15 Ghast Gold', []],
      ['LEGO Minecraft Karte 13 Skeleton Horseman', []],
      ['LEGO Minecraft Karte 5 Creeper Charged', []],
      // "Gold" is left over, glued by a hyphen or not: "Gold-Ghast" is "Gold Ghast".
      ['LEGO Minecraft Gold-Ghast Karte 131', []],
      ['LEGO Minecraft Wither-Skeleton Karte 13', []],
      ['LEGO Minecraft Glow-Squid Karte 12', []],
      // A word of another card's longer name (LE21 "Gold Ghast", #29 "Burning Zombie") is no
      // allowed word, even across a separator.
      ['LEGO Minecraft Karte 131 - Ghast (Gold)', []],
      ['LEGO Minecraft Karte 131 - Ghast - Gold', []],
      ['LEGO Minecraft Karte 6 - Zombie - Burning', []],
      // Only allowed words left over.
      ['LEGO Minecraft Karte 12 - Squid - Ultra Rare', ids('12')],
      // Brand, card and rarity words beside the name are fine.
      ['LEGO Minecraft Karte 13 Skeleton Ultra Rare', ids('13')],
      ['LEGO Minecraft Karte 41 Skeleton Horseman', ids('41')],
      ['Steve Karte 3 LEGO Minecraft', ids('3')],
    ]);
  });

  test('LE and XXL ids, with or without a space or leading zero', () => {
    check([
      ['LEGO Minecraft LE 19 - Creeper', ids('LE19')],
      ['LEGO Minecraft LE 019 - Creeper', ids('LE19')],
      ['LEGO Minecraft LE19 Creeper', ids('LE19')],
      ['LEGO Minecraft XXL1 Charged Creeper', ids('XXL1')],
      ['LEGO Minecraft XXL 1 - Charged Creeper', ids('XXL1')],
      // LE21 is "Gold Ghast", not "Ghast".
      ['LEGO Minecraft LE21 Ghast', []],
      // Base #5 is "Creeper" too: one name cannot confirm two numbers.
      ['LEGO Minecraft LE 19 - Creeper Karte 5', []],
      ['LEGO Minecraft LE  19 - Creeper', ids('LE19')],
    ]);
  });

  test('leading zeros, names with digits and puzzle cards', () => {
    check([
      ['LEGO Minecraft #0131 Ghast', ids('131')],
      ['LEGO Minecraft Karte 0015 Ghast', ids('15')],
      ['LEGO Minecraft Karte 154 - Puzzlekarte Oberwelt 1', ids('154')],
      // The digit in the name is not read as a card; #155 is "... Oberwelt 2".
      ['LEGO Minecraft Puzzlekarte Oberwelt 1 Karte 155', []],
      // The fixture's own form without "Serie 3": the name is not beside the number.
      ['LEGO Minecraft 154 - Oberwelt - Puzzlekarte', []],
    ]);
  });

  test('names match across case, umlaut spelling and punctuation, but not glued words', () => {
    check([
      ['LEGO Minecraft Karte 200 Sunny vs. Blaze', ids('200')],
      ['LEGO Minecraft Karte 200 Sunny vs Blaze', ids('200')],
      // "vsx" is one word, not "vs" then "x".
      ['LEGO Minecraft Karte 200 Sunny vsX Blaze', []],
      ['LEGO Minecraft Karte 201 DAS WÄCHTERDUELL', ids('201')],
      ['LEGO Minecraft Karte 201 Das Waechterduell', ids('201')],
      ['LEGO Minecraft Karte 2 Ender  Knight', ids('2')],
      ['LEGO Minecraft Karte 2 EnderKnight', []],
      ['LEGO Minecraft Karte 2 —Ender Knight', ids('2')],
      ['LEGO Minecraft Wither Skeleton Karte #4', ids('4')],
    ]);
  });
});

describe('isPictureCandidate', () => {
  test('a series 3 title naming no card, product, count or number is a candidate', () => {
    expect(isPictureCandidate('LEGO Minecraft On Fire Serie 3 Ender Dragon')).toBe(true);
    expect(isPictureCandidate('Lego Minecraft Karte Serie 3 Chast Ultra Rare')).toBe(true);
    expect(isPictureCandidate('LEGO Minecraft Serie 3 (2026) Steve Ultra Rare')).toBe(true);
    expect(isPictureCandidate('LEGO MINECRAFT ON FIRE LIMITED EDITION GOLD GHAST')).toBe(true);
  });

  test('a title failing the series 3 check or excluded is no candidate', () => {
    expect(isPictureCandidate('LEGO Minecraft Serie 1 Steve')).toBe(false);
    expect(isPictureCandidate('LEGO Minecraft Steve')).toBe(false);
    expect(isPictureCandidate('On Fire Karte Steve zum aussuchen')).toBe(false);
  });

  test('a product or count word makes it no candidate', () => {
    expect(isPictureCandidate('LEGO Minecraft Serie 3 Booster')).toBe(false);
    expect(isPictureCandidate('LEGO Minecraft On Fire Blister Ender Dragon')).toBe(false);
    expect(isPictureCandidate('LEGO Minecraft On Fire Steve Holo')).toBe(false);
    expect(isPictureCandidate('LEGO Minecraft On Fire Karten Steve Alex')).toBe(false);
    expect(isPictureCandidate('LEGO Minecraft On Fire Lot Creeper')).toBe(false);
  });

  test('any number besides the series and a year makes it no candidate', () => {
    // A count the patterns do not know: "6 TradingCards ... 1 special Card".
    expect(isPictureCandidate('lego© MINECRAFT 6  TradingCards ON FIRE incl. 1 special Card')).toBe(
      false
    );
    expect(isPictureCandidate('On Fire Steve 45')).toBe(false);
    expect(isPictureCandidate('On Fire Karte 12')).toBe(false);
    expect(isPictureCandidate('Serie 3 Steve 6+')).toBe(false);
  });

  test('every fixture title without ids is reviewed as a candidate or not', () => {
    for (const item of fixtureItems) {
      const key = fixtureKey(item);
      if ((FIXTURE_IDS[key] ?? []).length > 0) continue;
      expect({ key, title: item.title, candidate: isPictureCandidate(item.title) }).toEqual({
        key,
        title: item.title,
        candidate: FIXTURE_CANDIDATES.has(key),
      });
    }
  });
});

function makeFetch(
  options: {
    tokenStatus?: number;
    /** Token answer body; defaults to the fixture. */
    tokenBody?: string;
    searchStatus?: number;
    /** Body of the n-th search request (0-based), and its URL; defaults to the fixture. */
    searchBody?: (n: number, url: string) => string;
  } = {}
): {
  fetchFn: FetchFn;
  tokenCalls: number;
  searchUrls: string[];
  inits: RequestInit[];
} {
  const state = { tokenCalls: 0, searchUrls: [] as string[], inits: [] as RequestInit[] };
  const fetchFn: FetchFn = async (url, init) => {
    state.inits.push(init ?? {});
    if (url.includes('/identity/v1/oauth2/token')) {
      state.tokenCalls++;
      return new Response(options.tokenBody ?? readFixture('ebay-token.json'), {
        status: options.tokenStatus ?? 200,
      });
    }
    const body =
      options.searchBody?.(state.searchUrls.length, url) ?? readFixture('ebay-search.json');
    state.searchUrls.push(url);
    return new Response(body, { status: options.searchStatus ?? 200 });
  };
  return {
    fetchFn,
    get tokenCalls() {
      return state.tokenCalls;
    },
    searchUrls: state.searchUrls,
    inits: state.inits,
  };
}

const noSleep = async () => {};

describe('createEbayFetcher', () => {
  test('maps listings, skips items without ids and caches the token', async () => {
    const fake = makeFetch();
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 'secret',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const { listings, skippedNoId, skippedExcluded, skippedInvalid } =
      await adapter.fetchListings();
    // 4 made-up and 20 real items with ids, and 1 real picture candidate. Without: 13 real
    // titles excluded (6 pick lists, one of them "zufällige Auswahl", 5 series 1/2, 2 without a
    // series word), 1 made-up and 4 real series 3 titles naming no card.
    expect(listings).toHaveLength(25);
    expect(skippedExcluded).toBe(13);
    expect(skippedNoId).toBe(5);
    expect(skippedInvalid).toBe(0);
    expect(fake.tokenCalls).toBe(1);
    expect(fake.searchUrls).toHaveLength(S3_QUERIES.length);

    expect(listings.find((l) => l.format === 'auction')).toMatchObject({
      shop: 'ebay',
      cardIds: ['107'],
      cardName: null,
      idConflict: false,
      available: true,
      price: { cents: 149 + 160, currency: 'EUR' },
      auctionEndsAt: Date.parse('2026-11-20T18:30:00.000Z'),
      url: 'https://www.ebay.de/itm/110000000003',
    });
    // No legacyItemId on this item: the number comes from the middle of `v1|<n>|0`.
    expect(listings.find((l) => l.cardIds.some((id) => id === cid('LE8')))).toMatchObject({
      format: 'fixed_price',
      cardIds: ['12', '45', 'LE8'],
      price: { cents: 599, currency: 'EUR' },
      auctionEndsAt: null,
      imageUrl: 'https://i.ebayimg.com/images/g/bbb/s-l225.jpg',
    });
    const noImage = listings.find((l) => l.url.endsWith('110000000005'))!;
    expect(noImage.imageUrl).toBeNull();
    expect(noImage.price).toEqual({ cents: 200, currency: 'EUR' });
    expect(noImage.cardIds).toEqual([cid('107')]);
    expect(noImage.url).toBe('https://www.ebay.de/itm/110000000005');
    for (const l of listings) expect(l.url).not.toContain('?');

    // Real items.
    expect(listings.find((l) => l.url.endsWith('307033129412'))).toMatchObject({
      title: 'LEGO Minecraft Karten 226 - Vernetzungstreffen - Comickarte Serie 3 (2026)',
      cardIds: ['226'],
      price: { cents: 100 + 130, currency: 'EUR' },
      format: 'fixed_price',
    });
    expect(listings.some((l) => l.url.endsWith('298476153721'))).toBe(false);

    // The candidate carries no card ids; the picture decides (rule 4).
    expect(listings.find((l) => l.url.endsWith('336881691966'))).toMatchObject({
      title: 'Lego Minecraft Karte Serie 3 Chast Ultra Rare',
      cardIds: [],
      idSource: 'picture',
    });
    expect(listings.filter((l) => l.idSource === 'picture')).toHaveLength(1);
    expect(listings.filter((l) => l.cardIds.length === 0)).toHaveLength(1);
  });

  test('searches every query once, in order, the broad series 3 query included', async () => {
    expect(S3_QUERIES).toEqual([
      'lego minecraft on fire karte',
      'lego minecraft tcc serie 3',
      'lego minecraft trading card on fire',
      'lego minecraft karten serie 3',
    ]);
    const fake = makeFetch();
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    await adapter.fetchListings();
    expect(fake.searchUrls.map((u) => new URL(u).searchParams.get('q'))).toEqual([...S3_QUERIES]);
    expect(fake.searchUrls.map((u) => new URL(u).searchParams.get('offset'))).toEqual(
      SERIES_3_ONLY[0]!.queries.map(() => '0')
    );
  });

  test('excluded and id-less titles are counted apart and logged at debug level', async () => {
    const debug = spyOn(logger, 'debug');
    try {
      const fake = makeFetch({
        searchBody: () =>
          body(
            item({}),
            item({
              itemId: 'v1|220000000002|0',
              legacyItemId: '220000000002',
              title: 'LEGO Minecraft Serie 1 Karte Nr. 12',
            }),
            item({
              itemId: 'v1|220000000003|0',
              legacyItemId: '220000000003',
              title: 'LEGO Minecraft Serie 3 Booster',
            })
          ),
      });
      const adapter = createEbayFetcher({
        collections: SERIES_3_ONLY,
        clientId: 'id',
        clientSecret: 's',
        fetchFn: fake.fetchFn,
        sleep: noSleep,
      });
      const result = await adapter.fetchListings();
      expect(result).toMatchObject({ skippedExcluded: 1, skippedNoId: 1, skippedInvalid: 0 });
      expect(result.listings).toHaveLength(1);
      const lines = debug.mock.calls.map((c) => String(c[0]));
      expect(
        lines.some(
          (l) => l.includes('LEGO Minecraft Serie 1 Karte Nr. 12') && l.includes('other series')
        )
      ).toBe(true);
      expect(
        lines.some((l) => l.includes('LEGO Minecraft Serie 3 Booster') && l.includes('no card id'))
      ).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });

  test('a title without a series word counts when the catalog name stands beside its number', async () => {
    const debug = spyOn(logger, 'debug');
    try {
      const fake = makeFetch({
        searchBody: () =>
          body(
            item({
              itemId: 'v1|220000000131|0',
              legacyItemId: '220000000131',
              itemWebUrl: 'https://www.ebay.de/itm/220000000131',
              title: 'LEGO Minecraft Karte 131 - Ghast',
            }),
            item({
              itemId: 'v1|168608734848|0',
              legacyItemId: '168608734848',
              itemWebUrl: 'https://www.ebay.de/itm/168608734848',
              title: 'LEGO Minecraft Karte 104 - Ghast',
            }),
            item({
              itemId: 'v1|220000000103|0',
              legacyItemId: '220000000103',
              itemWebUrl: 'https://www.ebay.de/itm/220000000103',
              title: 'LEGO Minecraft Karte 103 - Ghast',
            }),
            item({
              itemId: 'v1|220000000132|0',
              legacyItemId: '220000000132',
              itemWebUrl: 'https://www.ebay.de/itm/220000000132',
              title: 'LEGO Minecraft Karte 131 - Ghast',
              itemGroupType: 'SELLER_DEFINED_VARIATIONS',
            })
          ),
      });
      let reads = 0;
      const adapter = createEbayFetcher({
        collections: SERIES_3_ONLY,
        clientId: 'id',
        clientSecret: 's',
        fetchFn: fake.fetchFn,
        sleep: noSleep,
        cardNames: (c) => {
          if (c !== 'lego-minecraft-3') return OTHER_SERIES_NAMES;
          reads++;
          return new Map([
            [cid('131'), 'Ghast'],
            [cid('104'), 'Ghast'],
            [cid('103'), 'Zombie'],
          ]);
        },
      });
      const result = await adapter.fetchListings();
      expect(result.listings.map((l) => [l.url, l.cardIds, l.idSource])).toEqual([
        ['https://www.ebay.de/itm/220000000131', ids('131'), undefined],
        // The listing of 2026-11-19: series 3 #104 is Ghast too.
        ['https://www.ebay.de/itm/168608734848', ids('104'), undefined],
      ]);
      // The 103 title (#103 is Zombie) and the variation listing stay excluded.
      expect(result.skippedExcluded).toBe(2);
      // The names are read once per fetch, not once per item or query.
      expect(reads).toBe(1);
      const lines = debug.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('Karte 131 - Ghast') && l.includes('catalog name'))).toBe(
        true
      );
    } finally {
      debug.mockRestore();
    }
  });

  test('a failing catalog name read fails the fetch, so stored listings are kept', async () => {
    const fake = makeFetch();
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
      cardNames: () => {
        throw new Error('database is locked');
      },
    });
    await expect(adapter.fetchListings()).rejects.toThrow('database is locked');
    expect(fake.searchUrls).toHaveLength(0);
  });

  test('with the real sammel-ente names, the fixture gives the same listings and counts', async () => {
    const names = new Map<CardId, string>();
    for (const page of ['sammel-ente-p1.html', 'sammel-ente-p11.html']) {
      for (const l of parseSammelEntePage(readFixture(page), null).listings) {
        if (l.cardName && l.cardIds.length === 1) names.set(l.cardIds[0]!, l.cardName);
      }
    }
    expect(names.size).toBeGreaterThan(20);
    const run = async (cardNames?: (c: CollectionId) => ReadonlyMap<CardId, string>) =>
      createEbayFetcher({
        collections: SERIES_3_ONLY,
        clientId: 'id',
        clientSecret: 's',
        fetchFn: makeFetch().fetchFn,
        sleep: noSleep,
        ...(cardNames ? { cardNames } : {}),
      }).fetchListings();
    // The fixture's three titles without a series word are a promo pack, a Panini pick list and
    // a 2021 "Trading Cards" title: none is read by name.
    expect(await run(s3Names(names))).toEqual(await run(s3Names(new Map())));
  });

  test('without catalog names, a title without a series word stays excluded', async () => {
    const fake = makeFetch({
      searchBody: () => body(item({ title: 'LEGO Minecraft Karte 131 - Ghast' })),
    });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const result = await adapter.fetchListings();
    expect(result.listings).toEqual([]);
    expect(result.skippedExcluded).toBe(1);
  });

  test('a listing with seller-defined variations gives no ids', async () => {
    const fake = makeFetch({
      searchBody: () =>
        body(
          item({
            title: 'LEGO Minecraft Serie 3 Karte Nr. 12',
            itemGroupType: 'SELLER_DEFINED_VARIATIONS',
          })
        ),
    });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    expect(await adapter.fetchListings()).toEqual({
      listings: [],
      skippedNoId: 0,
      skippedExcluded: 1,
      skippedInvalid: 0,
    });
  });

  describe('paging', () => {
    /** A search answer for the requested offset: `total` results, `perPage` per page. */
    const paged =
      (total: number, perPage = 200) =>
      (url: string) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
        const count = Math.max(0, Math.min(perPage, total - offset));
        const items = Array.from({ length: count }, (_, i) => {
          const n = String(500000000000 + offset + i);
          return item({
            itemId: `v1|${n}|0`,
            legacyItemId: n,
            itemWebUrl: `https://www.ebay.de/itm/${n}`,
          });
        });
        return JSON.stringify({ total, offset, limit: 200, itemSummaries: items });
      };

    const run = async (answer: (url: string) => string) => {
      const urls: string[] = [];
      const sleeps: number[] = [];
      const fetchFn: FetchFn = async (url) => {
        if (url.includes('/oauth2/token')) return new Response(readFixture('ebay-token.json'));
        urls.push(url);
        // eBay's rule, as its 400 answer of 2026-11-19 put it: "The 'offset' value must be
        // either zero or a multiple of the 'limit' value."
        const params = new URL(url).searchParams;
        if (Number(params.get('offset') ?? '0') % Number(params.get('limit')) !== 0) {
          return new Response('', { status: 400 });
        }
        return new Response(answer(url));
      };
      const adapter = createEbayFetcher({
        collections: SERIES_3_ONLY,
        clientId: 'id',
        clientSecret: 's',
        fetchFn,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      const result = await adapter.fetchListings();
      return { result, urls, sleeps };
    };
    const offsets = (urls: string[]) =>
      urls.map(
        (u) => `${new URL(u).searchParams.get('q')}@${new URL(u).searchParams.get('offset')}`
      );

    test('reads every page by offset and stops at the total', async () => {
      const { result, urls } = await run(paged(450));
      expect(offsets(urls).slice(0, 3)).toEqual([0, 200, 400].map((o) => `${S3_QUERIES[0]}@${o}`));
      expect(urls).toHaveLength(3 * S3_QUERIES.length);
      for (const u of urls) expect(u).toContain('limit=200');
      // Every query answers the same 450 items.
      expect(result.listings).toHaveLength(450);
    });

    test('one page when the total fits', async () => {
      const { urls } = await run(paged(200));
      expect(urls).toHaveLength(S3_QUERIES.length);
    });

    const runError = async (answer: (url: string) => string) =>
      run(answer).then(
        () => {
          throw new Error('expected a rejection');
        },
        (e: unknown) => e as Error
      );

    test('an empty later page while the total says more is a layout error (P1)', async () => {
      for (const later of [
        JSON.stringify({ total: 450, itemSummaries: [] }),
        JSON.stringify({ total: 450 }),
        JSON.stringify({}),
      ]) {
        const error = await runError((url) =>
          new URL(url).searchParams.get('offset') === '0' ? paged(450)(url) : later
        );
        expect(error).toBeInstanceOf(ShopLayoutError);
        expect(error.message).toContain(S3_QUERIES[0]!);
        expect(error.message).toContain('offset 200');
        expect(error.message).toContain('450');
      }
    });

    test('a first page without itemSummaries and without total is a layout error (P1)', async () => {
      const error = await runError((url) =>
        new URL(url).searchParams.get('q') === S3_QUERIES[1] ? '{}' : paged(10)(url)
      );
      expect(error).toBeInstanceOf(ShopLayoutError);
      expect(error.message).toContain(S3_QUERIES[1]!);
      // {"total":0} is a valid empty result.
      const { result } = await run((url) =>
        new URL(url).searchParams.get('q') === S3_QUERIES[1]
          ? JSON.stringify({ total: 0 })
          : paged(10)(url)
      );
      expect(result.listings).toHaveLength(10);
    });

    test('an empty first page with a small total is a layout error, not tolerated (G5)', async () => {
      for (const first of [
        JSON.stringify({ total: 3 }),
        JSON.stringify({ total: 3, itemSummaries: [] }),
        JSON.stringify({ total: 1, itemSummaries: [] }),
      ]) {
        const error = await runError((url) =>
          new URL(url).searchParams.get('q') === S3_QUERIES[1] ? first : paged(10)(url)
        );
        expect({ first, type: error.constructor.name }).toEqual({ first, type: 'ShopLayoutError' });
        expect(error.message).toContain('offset 0');
      }
      // A page-1 {"total":0} with an empty list stays a valid empty result.
      const { result } = await run((url) =>
        new URL(url).searchParams.get('q') === S3_QUERIES[1]
          ? JSON.stringify({ total: 0, itemSummaries: [] })
          : paged(10)(url)
      );
      expect(result.listings).toHaveLength(10);
    });

    test('an answer of an unexpected shape is a layout error naming query and offset (P2)', async () => {
      for (const answer of [
        'null',
        '[]',
        '"text"',
        JSON.stringify({ total: 3, itemSummaries: {} }),
        JSON.stringify({ total: '3', itemSummaries: [] }),
        JSON.stringify({ total: 3, itemSummaries: [null] }),
      ]) {
        const error = await runError(() => answer);
        expect({ answer, type: error.constructor.name }).toEqual({
          answer,
          type: 'ShopLayoutError',
        });
        expect(error.message).toContain('unexpected answer shape');
        expect(error.message).toContain(S3_QUERIES[0]!);
        expect(error.message).toContain('offset 0');
      }
    });

    test('the total shrinking mid-walk ends the walk (P4)', async () => {
      const { urls, result } = await run((url) => {
        const offset = new URL(url).searchParams.get('offset');
        return offset === '0' ? paged(450)(url) : paged(250)(url);
      });
      expect(urls).toHaveLength(2 * S3_QUERIES.length);
      expect(result.listings).toHaveLength(250);
    });

    test('the total shrinking on an empty page after short pages is checked against the items read', async () => {
      // 150 + 150 read, then an empty page at offset 400 announcing 390: 90 short.
      const error = await runError((url) => {
        const offset = new URL(url).searchParams.get('offset');
        if (offset === '400') return JSON.stringify({ total: 390, itemSummaries: [] });
        return paged(450, 150)(url);
      });
      expect(error).toBeInstanceOf(ShopLayoutError);
      expect(error.message).toContain('offset 400');
      expect(error.message).toContain('300 items read');
      expect(error.message).toContain('390');
    });

    test('a later page without total keeps the earlier total (P4)', async () => {
      // Without the kept total the full second page would ask for a third.
      const { urls } = await run((url) => {
        const answer = JSON.parse(paged(400)(url)) as Record<string, unknown>;
        if (new URL(url).searchParams.get('offset') !== '0') delete answer.total;
        return JSON.stringify(answer);
      });
      expect(urls).toHaveLength(2 * S3_QUERIES.length);
    });

    test('without any total, short pages continue and an empty page stops (P4)', async () => {
      const { urls, result } = await run((url) => {
        const answer = JSON.parse(paged(450, 199)(url)) as Record<string, unknown>;
        delete answer.total;
        return JSON.stringify(answer);
      });
      // 199, 199, 50, then the empty page at 600 ends the walk.
      expect(offsets(urls).slice(0, 4)).toEqual(
        [0, 200, 400, 600].map((o) => `${S3_QUERIES[0]}@${o}`)
      );
      expect(urls).toHaveLength(4 * S3_QUERIES.length);
      expect(result.listings).toHaveLength(448);
    });

    test('short pages with a total: the offset stays a multiple of the limit (P4)', async () => {
      // eBay answered 199 of 200 on 2026-11-19; asking for offset 199 next was a 400.
      const { urls, result } = await run(paged(450, 199));
      expect(offsets(urls).slice(0, 3)).toEqual([0, 200, 400].map((o) => `${S3_QUERIES[0]}@${o}`));
      expect(urls).toHaveLength(3 * S3_QUERIES.length);
      // 199 + 199 + 50 of 450: within the tolerance.
      expect(result.listings).toHaveLength(448);
    });

    test('short pages missing more than the tolerance are a layout error (P4)', async () => {
      // 150 + 150 + 50 of 450: 100 short; offset 400 was the last page by the total.
      const error = await runError(paged(450, 150));
      expect(error).toBeInstanceOf(ShopLayoutError);
      expect(error.message).toContain('offset 400');
      expect(error.message).toContain('350 items read');
      expect(error.message).toContain('total is 450');
    });

    test('a failure on a later query after the first returned items rejects (P4)', async () => {
      const error = await runError((url) => {
        if (new URL(url).searchParams.get('q') === S3_QUERIES[2]) return 'null';
        return paged(10)(url);
      });
      expect(error).toBeInstanceOf(ShopLayoutError);
    });

    test('stops at the page cap, warns and reports the cut searches (P3)', async () => {
      const warn = spyOn(logger, 'warn');
      try {
        const { urls, result } = await run(paged(5000));
        expect(urls).toHaveLength(5 * S3_QUERIES.length);
        expect(offsets(urls).slice(0, 5)).toEqual(
          [0, 200, 400, 600, 800].map((o) => `${S3_QUERIES[0]}@${o}`)
        );
        const lines = warn.mock.calls.map((c) => String(c[0]));
        for (const q of S3_QUERIES) {
          expect(lines.some((l) => l.includes(q) && l.includes('5000') && l.includes('1000'))).toBe(
            true
          );
        }
        expect(result.truncated).toHaveLength(S3_QUERIES.length);
        expect(result.truncated![0]).toContain(S3_QUERIES[0]!);
        expect(result.truncated![0]).toContain('5000');
      } finally {
        warn.mockRestore();
      }
    });

    test('at the cap without a total the warning says "more" (P4)', async () => {
      const warn = spyOn(logger, 'warn');
      try {
        const { result } = await run((url) => {
          const answer = JSON.parse(paged(5000)(url)) as Record<string, unknown>;
          delete answer.total;
          return JSON.stringify(answer);
        });
        expect(warn.mock.calls.some((c) => String(c[0]).includes('more'))).toBe(true);
        expect(result.truncated![0]).toContain('more');
      } finally {
        warn.mockRestore();
      }
    });

    test('a walk short of the total by the tolerance ends with a warning (F7)', async () => {
      const warn = spyOn(logger, 'warn');
      try {
        // 455 announced, 450 delivered: within max(5, 2 %). The third page is the last by the
        // total, so no fourth is asked for.
        const { result, urls } = await run((url) => {
          const answer = JSON.parse(paged(450)(url)) as Record<string, unknown>;
          answer.total = 455;
          return JSON.stringify(answer);
        });
        expect(urls).toHaveLength(3 * S3_QUERIES.length);
        expect(result.listings).toHaveLength(450);
        expect(result.truncated).toBeUndefined();
        const lines = warn.mock.calls.map((c) => String(c[0]));
        expect(
          lines.some((l) => l.includes(S3_QUERIES[0]!) && l.includes('455') && l.includes('450'))
        ).toBe(true);
        // 2 % of 1000 is 20: 1000 announced, 980 delivered is accepted too.
        const big = await run((url) => {
          const answer = JSON.parse(paged(980)(url)) as Record<string, unknown>;
          answer.total = 1000;
          return JSON.stringify(answer);
        });
        expect(big.result.listings).toHaveLength(980);
        expect(big.result.truncated).toBeUndefined();
        // 979 of 1000 is beyond the tolerance; five pages reach every offset below 1000, so the
        // walk is complete and short: a layout error.
        const short = await runError((url) => {
          const answer = JSON.parse(paged(979)(url)) as Record<string, unknown>;
          answer.total = 1000;
          return JSON.stringify(answer);
        });
        expect(short).toBeInstanceOf(ShopLayoutError);
        // 980 of 1002 at the cap: 20 missing below 1000 is within tolerance(1000) = 20, 22 of
        // the total beyond tolerance(1002) = 21, so a cut search.
        const cut = await run((url) => {
          const answer = JSON.parse(paged(980)(url)) as Record<string, unknown>;
          answer.total = 1002;
          return JSON.stringify(answer);
        });
        expect(cut.result.truncated).toHaveLength(S3_QUERIES.length);
        // 979 of 1001: 21 missing below 1000 is beyond tolerance(1000) = 20, though within
        // tolerance(1001) = 21: a layout error.
        const partial = await runError((url) => {
          const answer = JSON.parse(paged(979)(url)) as Record<string, unknown>;
          answer.total = 1001;
          return JSON.stringify(answer);
        });
        expect(partial).toBeInstanceOf(ShopLayoutError);
      } finally {
        warn.mockRestore();
      }
    });

    test('a walk short of the total beyond the tolerance is a layout error (F7)', async () => {
      for (const [total, delivered] of [
        [600, 400],
        // max(5, ceil(470 * 2 %)) = 10 < 20.
        [470, 450],
        [300, 200],
      ] as const) {
        const error = await runError((url) => {
          const answer = JSON.parse(paged(delivered)(url)) as Record<string, unknown>;
          answer.total = total;
          return JSON.stringify(answer);
        });
        expect({ total, type: error.constructor.name }).toEqual({ total, type: 'ShopLayoutError' });
        expect(error.message).toContain(String(total));
      }
    });

    test('at the cap, short pages below 1000 are a layout error, not a cut search (P3)', async () => {
      // 100 per page of 1500: 500 of the first 1000 offsets read.
      const error = await runError(paged(1500, 100));
      expect(error).toBeInstanceOf(ShopLayoutError);
      expect(error.message).toContain('500 items read of the first 1000');
      expect(error.message).toContain('1500');
      // 160 per page of 10000: 800 read; tolerance(10000) = 200 would let it pass.
      const large = await runError(paged(10000, 160));
      expect(large).toBeInstanceOf(ShopLayoutError);
      expect(large.message).toContain('800 items read of the first 1000');
      expect(large.message).toContain('tolerance 20');
    });

    test('at the cap, a total within the tolerance of 1000 counts as complete (P3)', async () => {
      const warn = spyOn(logger, 'warn');
      try {
        // tolerance(1021) = 21: five full pages are 21 short, accepted.
        for (const total of [1010, 1021]) {
          const { result } = await run((url) => {
            const answer = JSON.parse(paged(1000)(url)) as Record<string, unknown>;
            answer.total = total;
            return JSON.stringify(answer);
          });
          expect({ total, truncated: result.truncated }).toEqual({ total, truncated: undefined });
          expect(result.listings).toHaveLength(1000);
        }
        expect(warn.mock.calls.some((c) => String(c[0]).includes('within the tolerance'))).toBe(
          true
        );
        // tolerance(1022) = 21: 22 short is a cut search.
        const cut = await run((url) => {
          const answer = JSON.parse(paged(1000)(url)) as Record<string, unknown>;
          answer.total = 1022;
          return JSON.stringify(answer);
        });
        expect(cut.result.truncated).toHaveLength(S3_QUERIES.length);
      } finally {
        warn.mockRestore();
      }
    });

    test('no cap warning under the cap or at exactly 1000 results (P3)', async () => {
      const warn = spyOn(logger, 'warn');
      try {
        for (const total of [450, 1000]) {
          const { urls, result } = await run(paged(total));
          expect(result.truncated).toBeUndefined();
          expect(urls).toHaveLength(Math.ceil(total / 200) * S3_QUERIES.length);
        }
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    test('waits 1500 ms between two search requests', async () => {
      const { urls, sleeps } = await run(paged(450));
      expect(sleeps).toHaveLength(urls.length - 1);
      expect(new Set(sleeps)).toEqual(new Set([1500]));
    });

    test('a failing later page is a shop error', async () => {
      const fetchFn: FetchFn = async (url) => {
        if (url.includes('/oauth2/token')) return new Response(readFixture('ebay-token.json'));
        if (new URL(url).searchParams.get('offset') === '200')
          return new Response('', { status: 500 });
        return new Response(paged(450)(url));
      };
      const adapter = createEbayFetcher({
        collections: SERIES_3_ONLY,
        clientId: 'id',
        clientSecret: 's',
        fetchFn,
        sleep: noSleep,
      });
      await expect(adapter.fetchListings()).rejects.toBeInstanceOf(HttpError);
    });
  });

  const item = (over: Record<string, unknown>) => ({
    itemId: 'v1|220000000001|0',
    legacyItemId: '220000000001',
    title: 'LEGO Minecraft Serie 3 Karte Nr. 12',
    itemWebUrl: 'https://www.ebay.de/itm/220000000001?hash=item1:g:x&amdata=enc%3Afirst',
    price: { value: '1.00', currency: 'EUR' },
    buyingOptions: ['FIXED_PRICE'],
    ...over,
  });
  /** A one-page search answer; eBay always sends a total. */
  const body = (...items: object[]) =>
    JSON.stringify({ total: items.length, itemSummaries: items });

  test('the same item from two searches with different tracking data is one listing', async () => {
    const fake = makeFetch({
      searchBody: (n) =>
        body(
          item({
            itemWebUrl: `https://www.ebay.de/itm/220000000001?hash=item1:g:x&amdata=enc%3Asearch${n}`,
          })
        ),
    });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const first = (await adapter.fetchListings()).listings;
    const second = (await adapter.fetchListings()).listings;
    expect(first.map((l) => l.url)).toEqual(['https://www.ebay.de/itm/220000000001']);
    expect(second.map((l) => l.url)).toEqual(first.map((l) => l.url));
  });

  test('without any item id the web url is used without its query string', async () => {
    const fake = makeFetch({
      searchBody: () =>
        body(
          item({
            itemId: undefined,
            legacyItemId: undefined,
            itemWebUrl: 'https://www.ebay.de/itm/330000000001?hash=h&amdata=enc%3Ax',
          })
        ),
    });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    expect((await adapter.fetchListings()).listings.map((l) => l.url)).toEqual([
      'https://www.ebay.de/itm/330000000001',
    ]);
  });

  test('every search returning zero items is a layout error', async () => {
    const fake = makeFetch({ searchBody: () => JSON.stringify({ total: 0 }) });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    await expect(adapter.fetchListings()).rejects.toBeInstanceOf(ShopLayoutError);
  });

  test('a picture candidate is passed on without ids; a variation listing never is', async () => {
    const fake = makeFetch({
      searchBody: () =>
        body(
          item({ title: 'LEGO Minecraft On Fire Serie 3 Ender Dragon' }),
          item({
            itemId: 'v1|220000000002|0',
            legacyItemId: '220000000002',
            title: 'LEGO Minecraft On Fire Serie 3 Steve',
            itemGroupType: 'SELLER_DEFINED_VARIATIONS',
          }),
          item({
            itemId: 'v1|220000000003|0',
            legacyItemId: '220000000003',
            title: 'LEGO Minecraft Serie 3 Booster',
          })
        ),
    });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const result = await adapter.fetchListings();
    expect(result.listings).toEqual([
      expect.objectContaining({
        url: 'https://www.ebay.de/itm/220000000001',
        cardIds: [],
        idSource: 'picture',
      }),
    ]);
    expect(result).toMatchObject({ skippedExcluded: 1, skippedNoId: 1 });
  });

  test('a titled listing carries no picture id source', async () => {
    const fake = makeFetch({ searchBody: () => body(item({})) });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const [listing] = (await adapter.fetchListings()).listings;
    expect(listing!.cardIds).toEqual([cid('12')]);
    expect(listing!.idSource).toBeUndefined();
  });

  test('one search with items is enough, even when none of them names a card', async () => {
    const fake = makeFetch({
      searchBody: (n) => (n === 1 ? body(item({ title: 'LEGO Minecraft Booster' })) : body()),
    });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    // "LEGO Minecraft Booster" names no series: excluded, not "without card number".
    expect(await adapter.fetchListings()).toEqual({
      listings: [],
      skippedNoId: 0,
      skippedExcluded: 1,
      skippedInvalid: 0,
    });
  });

  test('sends marketplace, auth and user agent headers', async () => {
    const fake = makeFetch();
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 'secret',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    await adapter.fetchListings();
    const tokenHeaders = fake.inits[0]!.headers as Record<string, string>;
    expect(tokenHeaders.Authorization).toBe(`Basic ${btoa('id:secret')}`);
    expect(fake.inits[0]!.method).toBe('POST');
    const searchHeaders = fake.inits[1]!.headers as Record<string, string>;
    expect(searchHeaders['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_DE');
    expect(searchHeaders['User-Agent']).toContain('minecraft-cards-bot');
    expect(fake.searchUrls[0]).toContain('limit=200');
  });

  test('a token failure throws HttpError without leaking the secret', async () => {
    const fake = makeFetch({ tokenStatus: 401 });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 'topsecret',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const error = await adapter.fetchListings().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(401);
    expect((error as HttpError).message).not.toContain('topsecret');
  });

  test("a token failure names eBay's error but no other field of the answer", async () => {
    const fake = makeFetch({
      tokenStatus: 401,
      tokenBody: JSON.stringify({
        error: 'invalid_client',
        error_description: 'client authentication failed for topsecret',
        access_token: 'v^1.1#leaked',
      }),
    });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 'topsecret',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const error = (await adapter.fetchListings().catch((e: unknown) => e)) as HttpError;
    expect(error.message).toContain('invalid_client');
    expect(error.message).toContain('[redacted]');
    expect(error.message).not.toContain('topsecret');
    expect(error.message).not.toContain('leaked');
  });

  test('a failure body echoing the Basic credential is redacted (C3)', async () => {
    const basic = btoa('id:topsecret');
    const fake = makeFetch({
      tokenStatus: 401,
      tokenBody: JSON.stringify({ error: 'invalid_client', error_description: `bad ${basic}` }),
    });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 'topsecret',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const error = (await adapter.fetchListings().catch((e: unknown) => e)) as HttpError;
    expect(error.message).toContain('invalid_client');
    expect(error.message).not.toContain(basic);
    expect(error.message).toContain('bad [redacted]');
  });

  test('an empty secret does not garble the error text (C3)', async () => {
    const fake = makeFetch({
      tokenStatus: 401,
      tokenBody: JSON.stringify({ error: 'invalid_client' }),
    });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: '',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const error = (await adapter.fetchListings().catch((e: unknown) => e)) as HttpError;
    expect(error.message).toContain('invalid_client');
    expect(error.message).not.toContain('[redacted]i');
  });

  test('a failure answer without eBay error fields gives its message, else its field names only', async () => {
    const failWith = async (body: object) => {
      const fake = makeFetch({
        tokenStatus: 503,
        tokenBody: JSON.stringify({ ...body, access_token: 'v^1.1#leaked' }),
      });
      const adapter = createEbayFetcher({
        collections: SERIES_3_ONLY,
        clientId: 'id',
        clientSecret: 'topsecret',
        fetchFn: fake.fetchFn,
        sleep: noSleep,
      });
      return (await adapter.fetchListings().catch((e: unknown) => e)) as HttpError;
    };
    const withMessage = await failWith({ message: 'Service unavailable' });
    expect(withMessage.message).toContain('Service unavailable');
    expect(withMessage.message).not.toContain('leaked');
    const withFields = await failWith({ status: 'down' });
    expect(withFields.message).toContain('fields: status, access_token');
    expect(withFields.message).not.toContain('leaked');
    expect(withFields.message).not.toContain('down');
  });

  test('failure bodies that are not JSON objects, or have odd fields, are not echoed', async () => {
    const failRaw = async (tokenBody: string) => {
      const fake = makeFetch({ tokenStatus: 503, tokenBody });
      const adapter = createEbayFetcher({
        collections: SERIES_3_ONLY,
        clientId: 'id',
        clientSecret: 'topsecret',
        fetchFn: fake.fetchFn,
        sleep: noSleep,
      });
      return (await adapter.fetchListings().catch((e: unknown) => e)) as HttpError;
    };
    const asString = await failRaw(JSON.stringify('v^1.1#leaked'));
    expect(asString.message).toContain('JSON but not an object');
    expect(asString.message).not.toContain('leaked');
    const asArray = await failRaw(JSON.stringify(['v^1.1#leaked']));
    expect(asArray.message).toContain('answer is a JSON array');
    expect(asArray.message).not.toContain('leaked');
    const withTitle = await failRaw(JSON.stringify({ title: 'Bad Gateway' }));
    expect(withTitle.message).toContain('Bad Gateway');
    const errorsString = await failRaw(
      JSON.stringify({ errors: 'x', access_token: 'v^1.1#leaked' })
    );
    expect(errorsString.message).toContain('fields: errors, access_token');
    expect(errorsString.message).not.toContain('leaked');
    const oddLong = await failRaw(
      JSON.stringify({ errors: [{ longMessage: 5, message: 'Use the message' }] })
    );
    expect(oddLong.message).toContain('Use the message');
  });

  test("a search failure keeps at most 300 characters of eBay's error message", async () => {
    const fake = makeFetch({
      searchStatus: 400,
      searchBody: () =>
        JSON.stringify({ errors: [{ longMessage: `bad query ${'x'.repeat(500)}` }] }),
    });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const error = (await adapter.fetchListings().catch((e: unknown) => e)) as HttpError;
    expect(error).toBeInstanceOf(HttpError);
    expect(error.message).toContain('bad query');
    expect(error.message).toContain(fake.searchUrls[0]!);
    expect(error.message.length).toBeLessThan(fake.searchUrls[0]!.length + 340);
  });

  test('an answer that is not JSON names the URL', async () => {
    const fake = makeFetch({ searchBody: () => '<html>maintenance</html>' });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const error = (await adapter.fetchListings().catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('not JSON');
    expect(error.message).toContain('item_summary/search');
  });

  test('a search answer with errors and no items throws', async () => {
    const fake = makeFetch({
      searchBody: () => JSON.stringify({ errors: [{ message: 'Invalid category' }] }),
    });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    await expect(adapter.fetchListings()).rejects.toThrow('Invalid category');
  });

  test('one item per page against a large total is a layout error, not a cut search', async () => {
    // Every offset is read, but each page holds a single item: a partial walk, whether the total
    // fits the 1000 offsets (450) or not (5000, and 60000, whose own tolerance of 1200 would
    // cover every missing item). The cap warning itself is tested under paging.
    for (const total of [450, 5000, 60000]) {
      const fake = makeFetch({
        searchBody: () => JSON.stringify({ total, itemSummaries: [item({})] }),
      });
      const adapter = createEbayFetcher({
        collections: SERIES_3_ONLY,
        clientId: 'id',
        clientSecret: 's',
        fetchFn: fake.fetchFn,
        sleep: noSleep,
      });
      await expect(adapter.fetchListings()).rejects.toBeInstanceOf(ShopLayoutError);
    }
  });

  test('items without a usable link or title are counted as invalid', async () => {
    const fake = makeFetch({
      searchBody: () =>
        body(
          item({}),
          item({ title: undefined }),
          item({ itemId: undefined, legacyItemId: undefined, itemWebUrl: undefined })
        ),
    });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    const result = await adapter.fetchListings();
    expect(result.listings).toHaveLength(1);
    // Two bad items, each counted once although every search returns them (C2).
    expect(result.skippedInvalid).toBe(2);
  });

  describe('token expiry', () => {
    let clock: ReturnType<typeof spyOn>;
    afterEach(() => {
      clock.mockRestore();
    });

    test('a token is reused until shortly before it expires, then fetched again', async () => {
      let now = 1_000_000;
      clock = spyOn(Date, 'now').mockImplementation(() => now);
      const fake = makeFetch({
        tokenBody: JSON.stringify({ access_token: 't', expires_in: 7200 }),
      });
      const adapter = createEbayFetcher({
        collections: SERIES_3_ONLY,
        clientId: 'id',
        clientSecret: 's',
        fetchFn: fake.fetchFn,
        sleep: noSleep,
      });
      await adapter.fetchListings();
      now += 60 * 60 * 1000;
      await adapter.fetchListings();
      expect(fake.tokenCalls).toBe(1);
      // 7200 s minus the 60 s safety margin.
      now = 1_000_000 + 7140 * 1000;
      await adapter.fetchListings();
      expect(fake.tokenCalls).toBe(2);
    });
  });

  describe('prices', () => {
    const priceOf = async (over: Record<string, unknown>) => {
      const fake = makeFetch({ searchBody: () => body(item(over)) });
      const adapter = createEbayFetcher({
        collections: SERIES_3_ONLY,
        clientId: 'id',
        clientSecret: 's',
        fetchFn: fake.fetchFn,
        sleep: noSleep,
      });
      return (await adapter.fetchListings()).listings[0]!.price;
    };

    test('shipping in another currency is not added', async () => {
      expect(
        await priceOf({
          price: { value: '1.00', currency: 'EUR' },
          shippingOptions: [{ shippingCost: { value: '3.00', currency: 'GBP' } }],
        })
      ).toEqual({ cents: 100, currency: 'EUR' });
    });

    test('one decimal and extra decimals are read without float rounding', async () => {
      expect(await priceOf({ price: { value: '1.5', currency: 'EUR' } })).toEqual({
        cents: 150,
        currency: 'EUR',
      });
      expect(await priceOf({ price: { value: '1.499', currency: 'EUR' } })).toEqual({
        cents: 149,
        currency: 'EUR',
      });
    });
  });

  test('a search failure throws HttpError', async () => {
    const fake = makeFetch({ searchStatus: 500 });
    const adapter = createEbayFetcher({
      collections: SERIES_3_ONLY,
      clientId: 'id',
      clientSecret: 'secret',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    });
    await expect(adapter.fetchListings()).rejects.toBeInstanceOf(HttpError);
  });
});

describe('series markers (2026-11-24 probe)', () => {
  test('a series 1 title belongs to series 1, with its ids', () => {
    const title = 'LEGO Minecraft Serie 1 Trading Card 134 - Neon Lohe - Mob Karte - Neon';
    expect(classifyTitle(title)).toEqual({ collection: 'lego-minecraft-1' });
    expect(extractCardIdsFromTitle(title, 'lego-minecraft-1')).toEqual(ids('134'));
    // Never a series 3 id.
    expect(extractCardIdsFromTitle(title)).toEqual([]);
  });

  test('a card number after "Serie N -" is no series list', () => {
    const s3 = 'LEGO Minecraft Serie 3 - 12 - Steve - Charakterkarte';
    expect(classifyTitle(s3)).toEqual({ collection: 'lego-minecraft-3' });
    expect(extractCardIdsFromTitle(s3)).toEqual(ids('12'));
    expect(classifyTitle('LEGO Minecraft Serie 1 - 68 - Yeti - Skin Karte')).toEqual({
      collection: 'lego-minecraft-1',
    });
    for (const title of [
      'LEGO Minecraft Serie 3 - 12 Karte Steve',
      'LEGO Minecraft Serie 3 - 7 Karte',
      'LEGO Minecraft Serie 3 / 45 Steve Karte',
    ]) {
      expect(classifyTitle(title)).toEqual({ collection: 'lego-minecraft-3' });
    }
    // A series list stays one, also before "Karte" and before a dash and a word; "Serie 1 - 2 -
    // Steve" may be series 1 #2 or a list: unclear, so no ids.
    for (const title of [
      'LEGO Minecraft Serie 1 - 2 Karte 45',
      'LEGO Minecraft Serie 1 & 2 - Karte 45',
      'LEGO Minecraft Serie 1-2 - Karte 45',
      'LEGO Minecraft Serie 1 und 2 - Trading Card 45',
      'LEGO Minecraft Serie 1, 2 - Karte 45',
      'LEGO Minecraft TCC 1 & 2 - Karte 45',
      'LEGO Minecraft Serie 2 & 3 - Karte 12',
      'LEGO Minecraft Serie 1 - 2 - Steve - Skin Karte',
    ]) {
      expect(classifyTitle(title)).toEqual({ exclusion: 'several collections' });
    }
  });

  test('Staffel 3 and TCC 3 name series 3', () => {
    for (const title of ['LEGO Minecraft Staffel 3 Karte 12', 'LEGO Minecraft TCC 3 Karte 12']) {
      expect(classifyTitle(title)).toEqual({ collection: 'lego-minecraft-3' });
    }
    expect(classifyTitle('LEGO Minecraft TCC 30 Karte 12')).toEqual({ exclusion: 'no series' });
  });

  test('Boom-Bastic, TNT Boom and Staffel 2 name series 2', () => {
    for (const title of [
      'Blue Ocean LEGO Minecraft 2025 Sammelkarte 216 Trading Cards Boom-Bastic TNT',
      'LEGO Minecraft Boom Bastic Karte 12',
      'LEGO Minecraft Staffel 2 Karte 131 - Ghast',
    ]) {
      expect(classifyTitle(title)).toEqual({ collection: 'lego-minecraft-2' });
    }
  });

  test('a title naming two series is excluded', () => {
    expect(classifyTitle('Lego Minecraft Karten Serie 1 und Serie 3 Lot')).toEqual({
      exclusion: 'several collections',
    });
    expect(
      classifyTitle('LEGO Minecraft Boom Bastic One Fire Serie 3 98 Verschiedene Karten Neu')
    ).toEqual({
      exclusion: 'several collections',
    });
  });

  test('a series list with one series word names several collections', () => {
    for (const title of [
      'LEGO Minecraft Serie 1-2 Karte 45',
      'LEGO Minecraft Serie 1 und 2 Karte 45',
      'LEGO Minecraft Serie 1 & 2 Karte 45',
      'LEGO Minecraft Serie 1+2 Karte 45',
      'LEGO Minecraft Serie 1/2 Karte 45',
      'LEGO Minecraft Serie 1, 2, 3 Karte 45',
      'LEGO Minecraft Serie 2 und 3 Karte 45',
      'LEGO Minecraft Serie 2/3 Karte 45',
    ]) {
      expect(classifyTitle(title)).toEqual({ exclusion: 'several collections' });
    }
    // One series and a year, or a card number, stay one series.
    expect(classifyTitle('LEGO Minecraft Serie 3 - 2026 Karte 12')).toEqual({
      collection: 'lego-minecraft-3',
    });
    expect(classifyTitle('LEGO Minecraft Serie 1 Karte 45')).toEqual({
      collection: 'lego-minecraft-1',
    });
  });

  test('a title naming no series is "no series"', () => {
    expect(classifyTitle('LEGO Minecraft Sammelkarte / Trading Card Nr. 242')).toEqual({
      exclusion: 'no series',
    });
  });

  test('every fixture item gets its reviewed collection and ids', () => {
    const items = (
      JSON.parse(readFixture('ebay-search-series-1-2.json')) as {
        itemSummaries: { title: string }[];
      }
    ).itemSummaries;
    const read = items.map(({ title }) => {
      const c = classifyTitle(title);
      if ('exclusion' in c) return `${c.exclusion} | ${title}`;
      const why = titleExclusion(title, c.collection);
      if (why) return `${why} | ${title}`;
      return `${c.collection} ${extractCardIdsFromTitle(title, c.collection).join(',') || '-'} | ${title}`;
    });
    expect(read).toMatchSnapshot();
  });
});

describe('the name rule across series', () => {
  const s3 = new Map([[cid('104'), 'Ghast']]);

  test('a series 3 name another series has at that number gives no id', () => {
    expect(
      nameMatchedCardIds('LEGO Minecraft Karte 104 - Ghast', s3, [new Map([[cid('104'), 'Ghast']])])
    ).toEqual([]);
    // However it is spelled there.
    expect(
      nameMatchedCardIds('LEGO Minecraft Karte 104 - Ghast', s3, [new Map([[cid('104'), 'GHAST']])])
    ).toEqual([]);
  });

  test('a name only series 3 has at that number still counts', () => {
    expect(
      nameMatchedCardIds('LEGO Minecraft Karte 104 - Ghast', s3, [new Map([[cid('104'), 'Blaze']])])
    ).toEqual(ids('104'));
  });

  test('another catalog not synced yet changes nothing', () => {
    expect(nameMatchedCardIds('LEGO Minecraft Karte 104 - Ghast', s3, [new Map()])).toEqual(
      ids('104')
    );
  });
});

describe('one eBay run for every collection', () => {
  /** A one-item search answer. */
  const oneItem = (title: string) =>
    JSON.stringify({
      total: 1,
      itemSummaries: [
        {
          itemId: 'v1|250000000001|0',
          legacyItemId: '250000000001',
          title,
          itemWebUrl: 'https://www.ebay.de/itm/250000000001',
          price: { value: '1.00', currency: 'EUR' },
          buyingOptions: ['FIXED_PRICE'],
        },
      ],
    });

  test("the default run searches every collection's queries once, in registry order", () => {
    expect([...EBAY_QUERIES]).toEqual([
      'lego minecraft karten serie 1',
      'lego minecraft tcc serie 1',
      'lego minecraft karten serie 2',
      'lego minecraft boom bastic karte',
      'lego minecraft on fire karte',
      'lego minecraft tcc serie 3',
      'lego minecraft trading card on fire',
      'lego minecraft karten serie 3',
    ]);
  });

  test("no name is read while another series' catalog is not loaded yet", async () => {
    const ghast = {
      itemId: 'v1|230000000001|0',
      legacyItemId: '230000000001',
      title: 'LEGO Minecraft Karte 104 - Ghast',
      itemWebUrl: 'https://www.ebay.de/itm/230000000001',
      price: { value: '1.00', currency: 'EUR' },
      buyingOptions: ['FIXED_PRICE'],
    };
    const fake = makeFetch({
      searchBody: () => JSON.stringify({ total: 1, itemSummaries: [ghast] }),
    });
    const run = (s1: Map<CardId, string>) =>
      createEbayFetcher({
        collections: EBAY_COLLECTIONS.filter((c) => c.id !== 'lego-minecraft-2'),
        clientId: 'id',
        clientSecret: 's',
        fetchFn: fake.fetchFn,
        sleep: noSleep,
        cardNames: (c) => (c === 'lego-minecraft-3' ? new Map([[cid('104'), 'Ghast']]) : s1),
      }).fetchListings();
    // Series 1 not synced: unsure, no id.
    expect((await run(new Map())).listings).toEqual([]);
    // Synced, without a Ghast at #104: series 3's.
    expect((await run(new Map([[cid('1'), 'Steve']]))).listings.map((l) => l.cardIds)).toEqual([
      ids('104'),
    ]);
  });

  test('the fetcher stores each title in the collection it names', async () => {
    const at = (n: number, title: string) => ({
      itemId: `v1|24000000000${n}|0`,
      legacyItemId: `24000000000${n}`,
      title,
      itemWebUrl: `https://www.ebay.de/itm/24000000000${n}`,
      price: { value: '1.00', currency: 'EUR' },
      buyingOptions: ['FIXED_PRICE'],
    });
    const items = [
      at(1, 'LEGO Minecraft Serie 1 Trading Card 134 - Neon Lohe - Mob Karte - Neon'),
      at(2, 'LEGO MINECRAFT TNT BOOM Serie 2 ULTRA RARE CREEPER 12 Karte Trading Card'),
      at(3, 'LEGO Minecraft On Fire Karte 12'),
    ];
    const fake = makeFetch({
      searchBody: () => JSON.stringify({ total: items.length, itemSummaries: items }),
    });
    const { listings, namesUnknown } = await createEbayFetcher({
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
      cardNames: () => new Map(),
    }).fetchListings();
    expect(listings.map((l) => [l.collection, l.cardIds])).toEqual([
      ['lego-minecraft-1', ids('134')],
      ['lego-minecraft-2', ids('12')],
      ['lego-minecraft-3', ids('12')],
    ]);
    // Without catalog names nothing was read by name; series 1 and 2 are named for the alert.
    expect(namesUnknown).toEqual(['lego-minecraft-1', 'lego-minecraft-2']);
  });

  test('without series 3, or without catalog names, no unloaded card list is reported', async () => {
    const fake = makeFetch({
      searchBody: () => oneItem('LEGO Minecraft Serie 1 Trading Card 4 - X - Skin Karte'),
    });
    const run = (over: Partial<Parameters<typeof createEbayFetcher>[0]>) =>
      createEbayFetcher({
        clientId: 'id',
        clientSecret: 's',
        fetchFn: fake.fetchFn,
        sleep: noSleep,
        ...over,
      }).fetchListings();
    const s1 = EBAY_COLLECTIONS.filter((c) => c.id === 'lego-minecraft-1');
    expect(
      (await run({ collections: s1, cardNames: () => new Map() })).namesUnknown
    ).toBeUndefined();
    expect((await run({})).namesUnknown).toBeUndefined();
  });

  test('a collection whose own searches all return nothing is reported, the others read', async () => {
    const fake = makeFetch({
      searchBody: (_n, url) =>
        ['lego minecraft karten serie 1', 'lego minecraft tcc serie 1'].includes(
          new URL(url).searchParams.get('q') ?? ''
        )
          ? JSON.stringify({ total: 0, itemSummaries: [] })
          : oneItem('LEGO Minecraft On Fire Karte 12'),
    });
    const result = await createEbayFetcher({
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
    }).fetchListings();
    expect(result.emptySearches).toEqual(['lego-minecraft-1']);
    expect(result.listings.map((l) => l.collection)).toEqual(['lego-minecraft-3']);
  });

  test('the fetcher places titles with the markers it is given', async () => {
    const fake = makeFetch({
      searchBody: () => oneItem('LEGO Minecraft FOO Karte 12'),
    });
    const s1 = EBAY_COLLECTIONS.find((c) => c.id === 'lego-minecraft-1')!;
    const { listings } = await createEbayFetcher({
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fake.fetchFn,
      sleep: noSleep,
      collections: [{ ...s1, series: /\bFOO\b/i }],
    }).fetchListings();
    expect(listings.map((l) => [l.collection, l.cardIds])).toEqual([
      ['lego-minecraft-1', ids('12')],
    ]);
  });
});
