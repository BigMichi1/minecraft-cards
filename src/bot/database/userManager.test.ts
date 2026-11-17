import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { db, initializeDatabase } from './db';
import { cards, users, wantedCards } from './schema/index';
import { catalogManager } from './catalogManager';
import { userManager } from './userManager';

describe('userManager', () => {
  beforeAll(() => {
    initializeDatabase();
  });

  beforeEach(() => {
    db.delete(wantedCards).run();
    db.delete(users).run();
    db.delete(cards).run();
    catalogManager.seedIfEmpty();
  });

  test('setList replaces the list and a failed set changes nothing', () => {
    expect(userManager.setList('u1', '12, 45, LE8')).toEqual({
      ok: true,
      ids: ['12', '45', 'LE8'],
    });
    expect(userManager.setList('u1', '12, 999, abc')).toEqual({
      ok: false,
      invalid: ['abc', '999'],
    });
    expect(userManager.getList('u1')).toEqual(['12', '45', 'LE8']);
    expect(userManager.setList('u1', '3')).toEqual({ ok: true, ids: ['3'] });
    expect(userManager.getList('u1')).toEqual(['3']);
  });

  test('addToList and removeFromList', () => {
    userManager.setList('u1', '12, 45, LE8');
    expect(userManager.addToList('u1', '1-3')).toEqual({
      ok: true,
      ids: ['1', '2', '3', '12', '45', 'LE8'],
    });
    expect(userManager.addToList('u1', '999')).toEqual({ ok: false, invalid: ['999'] });
    userManager.removeFromList('u1', '45');
    expect(userManager.getList('u1')).toEqual(['1', '2', '3', '12', 'LE8']);
  });

  test('removeFromList ignores catalog membership', () => {
    userManager.setList('u1', '12');
    db.delete(cards).run();
    expect(userManager.removeFromList('u1', '12')).toEqual({ ok: true, ids: [] });
    expect(userManager.removeFromList('u1', 'abc')).toEqual({ ok: false, invalid: ['abc'] });
  });

  test('clearList and getList for unknown user', () => {
    expect(userManager.getList('nobody')).toEqual([]);
    userManager.setList('u1', '12');
    userManager.clearList('u1');
    expect(userManager.getList('u1')).toEqual([]);
  });

  test('allWantedIds and usersWanting', () => {
    userManager.setList('u1', '1-3, 12, LE8');
    userManager.setList('u2', '12');
    expect(userManager.allWantedIds()).toEqual(new Set(['1', '2', '3', '12', 'LE8']));
    expect(userManager.usersWanting(['12', '3'])).toEqual(
      new Map([
        ['u1', ['3', '12']],
        ['u2', ['12']],
      ])
    );
    expect(userManager.usersWanting([])).toEqual(new Map());
  });

  test('markDmFailed and takeDmFailure', () => {
    userManager.setList('u1', '12');
    userManager.markDmFailed('u1', 1);
    expect(userManager.takeDmFailure('u1')).toBe(true);
    expect(userManager.takeDmFailure('u1')).toBe(false);
    expect(userManager.takeDmFailure('nobody')).toBe(false);
  });
});
