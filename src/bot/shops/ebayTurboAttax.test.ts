import { describe, expect, test } from 'bun:test';
import { ids } from '../../test/cardIds';
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
  ])('%s gives nothing', (title) => {
    expect(readTurboAttaxCardIds(title)).toEqual([]);
  });
});

describe('hasTurboAttaxRange', () => {
  test.each([
    'Topps Turbo Attax F1 2026 - Formula 1 2026 - Einzelkarten zum aussuchen #1 - 264',
    'Topps Turbo Attax 2026 / PICK YOUR CARD (1-288) - KARTE AUSWÄHLEN',
    'Turbo Attax 2026 F1 l Legends of the Grid l Complete Set l 15 Karten l #136-150',
    'Topps Turbo Attax 2026 Greats of the Grid GG1-GG8',
    'Topps Turbo Attax 2026 Limited Edition LE 1 bis LE 18',
  ])('%s is a range', (title) => {
    expect(hasTurboAttaxRange(title)).toBe(true);
  });

  test.each([
    'Topps Turbo Attax 2026 - Kimi Antonelli - # 16',
    'Turbo Attax F1 (Formel 1 / Formula 1) 2026 BG 2 Franco Colapinto (Black Gold)',
    'Topps Turbo Attax Formel 1 - 2026 Karten',
    'GG8 - Michael Schumacher - Greats Of The Grid - Limited Edition Turbo Attax 2026',
    'Topps Turbo Attax 2026 #288 - 150',
  ])('%s is no range', (title) => {
    expect(hasTurboAttaxRange(title)).toBe(false);
  });
});
