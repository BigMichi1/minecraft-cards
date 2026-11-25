import { describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
import { cid, ids } from '../../test/cardIds';
import { hasTurboAttaxRange, readTurboAttaxCardIds } from './ebayTurboAttax';

describe('readTurboAttaxCardIds', () => {
  test.each([
    ['Topps Turbo Attax 2026 Formel 1 Mark Webber Turbo Chrome #340 Trading Card', ['340']],
    ['Topps Turbo Attax 2026 - Kimi Antonelli - # 16', ['16']],
    ['Topps F1 Turbo Attax 2026 Trading Card 2026 Technical Drawing Basis-Karte NO 264', ['264']],
    ['Topps Turbo Attax 2026 Nr. 12 George Russell', ['12']],
    ['Topps Turbo Attax 2026 #012 George Russell', ['12']],
    ['Turbo Attax 2026 LE4 Lewis Hamilton Limited Edition ', ['LE4']],
    ['Topps Turbo Attax F1 2026  - Limited Edition - Charles Leclerc #LE6', ['LE6']],
    ['Turbo Attax F1 (Formel 1 / Formula 1) 2026 BG 2 Franco Colapinto (Black Gold)', ['BG2']],
    ['Topps Turbo Attax 2026 F1 I Greats of the Grid I Lewis Hamilton I #GG1', ['GG1']],
    ['Turbo Attax 2026 Sunshine State SUN 03 Lando Norris', ['SUN3']],
    ['Turbo Attax 2026 Guardians of the Grid GU7', ['GU7']],
    ['Topps Formula 1 Turbo Attax 2026 Relic Max Verstappen Oracle Red Bull MR-VER', ['MR-VER']],
    ['Sir Jackie Stewart MRSTE Relic Legend Turbo Attax 2026', ['MR-STE']],
    ['Turbo Attax 2026 Raceday Relic RR ALB Alex Albon', ['RR-ALB']],
    ['Topps F1 Turbo Attax 2026 Lewis Hamilton „The Winning Formula“ #341 1:250', ['341']],
    [
      'Topps F1 Turbo Attax 2026 Driver Core 3x Karten Lot Alonso Sainz #157 #163 #174',
      ['157', '163', '174'],
    ],
    // Another driver's race number is a card number.
    ['Topps Turbo Attax 2026 Lewis Hamilton #4 Ferrari', ['4']],
    // A lot naming a driver loses his race number, whatever stands between (unsure: logged).
    ['Turbo Attax 2026 Lot Alonso Sainz #14 #163', ['163']],
  ])('%s', (title, expected) => {
    expect(readTurboAttaxCardIds(title)).toEqual(ids(...expected));
  });

  test.each([
    // Bare numbers, `Karte N`/`Card N` and the year are never ids.
    'Topps F1 Turbo Attax 2026 La Monumental 2x Karten Lot Colapinto Albon 225 214',
    '2026 Turbo Attax 237 - Carlos Sainz - Turbo Attax Legacy',
    'Topps Turbo Attax 2026 Charles Leclerc Lewis Hamilton Ferrari 8 Karten Lot',
    'Topps Turbo Attax 2026 Trading Card 2026',
    'Topps Turbo Attax 2026 Karte 25 Isack Hadjar',
    // Counts after a prefixed number.
    'Turbo Attax 2026 #5 Stück',
    'Turbo Attax 2026 Nr. 1 Händler',
    // Unknown prefixes and lowercase relic look-alikes.
    '2026 Topps Turbo Attax Kimi Antonelli KA5 Limited Edition Silverstone Exclusive',
    'Topps F1 Turbo Attax 2026 Oliver Bearman Haas Night Shift #NS-4',
    'Turbo Attax 2026 Mr Hamilton',
    'Turbo Attax 2026 Formula 1 F1 F2',
    // A prefix glued to a word: "LE 24h" is no LE24.
    'Turbo Attax 2026 Le Mans LE 24h',
    // Relic codes count only in a relic's title: capitals elsewhere are words.
    'Turbo Attax 2026 MR BIG RR TOP Lot',
    // A driver's race number beside the driver is no card number.
    'Topps Turbo Attax 2026 Lewis Hamilton #44 Ferrari',
    'Topps Turbo Attax 2026 Max Verstappen #1 Red Bull',
    'Topps Turbo Attax 2026 Lando Norris No 4 McLaren',
    'Topps Turbo Attax 2026 Nico Hülkenberg #27 Audi',
    // The driver anywhere in the title: first names, teams and separators between change nothing.
    'Topps Turbo Attax 2026 #44 Lewis Hamilton Ferrari',
    'Topps Turbo Attax 2026 Max Verstappen Red Bull #1',
    'Topps Turbo Attax 2026 F1 I Lewis Hamilton I #44',
    'Topps Turbo Attax 2026 Lewis Hamilton l #44 l Ferrari',
    'Topps Turbo Attax 2026 Verstappen / #1',
    'Topps Turbo Attax 2026 Nico Huelkenberg #27',
    'Topps Turbo Attax 2026 Kimi Raeikkoenen #7',
    // Legends race too.
    'Topps Turbo Attax 2026 Michael Schumacher #1 Legend',
    'Topps Turbo Attax 2026 Nigel Mansell #5 Legend',
    // Without the catalog the driver's own card cannot be told from his race number.
    'Topps Turbo Attax 2026 Lando Norris #4',
  ])('%s gives nothing', (title) => {
    expect(readTurboAttaxCardIds(title)).toEqual([]);
  });
});

describe("the catalog keeps a driver's own card", () => {
  const names = new Map([
    [cid('4'), 'Lando Norris'],
    [cid('12'), 'George Russell / Kimi Antonelli'],
    [cid('44'), 'Carlos Sainz'],
  ]);
  test.each([
    ['Topps Turbo Attax 2026 Lando Norris #4', ['4']],
    ['Topps Turbo Attax 2026 Kimi Antonelli #12', ['12']],
    ['Topps Turbo Attax 2026 Lewis Hamilton #44 Ferrari', []],
  ])('%s', (title, expected) => {
    expect(readTurboAttaxCardIds(title, names)).toEqual(ids(...expected));
  });

  test('every dropped number is logged with its reason', () => {
    const debug = spyOn(logger, 'debug');
    try {
      readTurboAttaxCardIds('Topps Turbo Attax 2026 Lewis Hamilton #44 Ferrari', names);
      readTurboAttaxCardIds('Turbo Attax 2026 Patch MR-VER Verstappen');
      const lines = debug.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('#44') && l.includes('race number'))).toBe(true);
      expect(lines.some((l) => l.includes('MR-VER') && l.includes('no relic word'))).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });
});

describe('hasTurboAttaxRange', () => {
  test.each([
    'Topps Turbo Attax F1 2026 - Formula 1 2026 - Einzelkarten zum aussuchen #1 - 264',
    'Topps Turbo Attax 2026 / PICK YOUR CARD (1-288) - KARTE AUSWÄHLEN',
    'Turbo Attax 2026 F1 l Legends of the Grid l Complete Set l 15 Karten l #136-150',
    'Topps Turbo Attax 2026 Greats of the Grid GG1-GG8',
    'Topps Turbo Attax 2026 Limited Edition LE 1 bis LE 18',
    'Topps Turbo Attax 2026 Einzelkarten #1 to #264',
    'Topps Turbo Attax 2026 Einzelkarten 1 to 264',
    'Topps Turbo Attax 2026 Karten 1~150',
    // Any order: a choice either way.
    'Topps Turbo Attax 2026 #121-120',
    'Topps Turbo Attax 2026 #288 - 150',
  ])('%s is a range', (title) => {
    expect(hasTurboAttaxRange(title)).toBe(true);
  });

  test.each([
    'Topps Turbo Attax 2026 - Kimi Antonelli - # 16',
    'Turbo Attax F1 (Formel 1 / Formula 1) 2026 BG 2 Franco Colapinto (Black Gold)',
    'Topps Turbo Attax Formel 1 - 2026 Karten',
    'GG8 - Michael Schumacher - Greats Of The Grid - Limited Edition Turbo Attax 2026',
    'Topps Turbo Attax 2026 Max Verstappen #3 2026 F1',
  ])('%s is no range', (title) => {
    expect(hasTurboAttaxRange(title)).toBe(false);
  });
});
