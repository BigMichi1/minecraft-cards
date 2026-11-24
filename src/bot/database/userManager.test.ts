import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, initializeDatabase } from './db';
import { cards, users, wantedCards } from './schema/index';
import { catalogManager } from './catalogManager';
import { userManager } from './userManager';
import { cid, ids } from '../../test/cardIds';
import type { CollectionId } from '../collections/ids';

/** A collection outside the registry, to show lists stay inside their own collection. */
const OTHER = 'other-set' as CollectionId;

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
    expect(userManager.setList('u1', 'lego-minecraft-3', '12, 45, LE8')).toEqual({
      ok: true,
      ids: ids('12', '45', 'LE8'),
    });
    expect(userManager.setList('u1', 'lego-minecraft-3', '12, 999, abc')).toEqual({
      ok: false,
      reason: 'invalid',
      invalid: ['abc', '999'],
    });
    expect(userManager.getList('u1', 'lego-minecraft-3')).toEqual(ids('12', '45', 'LE8'));
    expect(userManager.setList('u1', 'lego-minecraft-3', '3')).toEqual({ ok: true, ids: ids('3') });
    expect(userManager.getList('u1', 'lego-minecraft-3')).toEqual([cid('3')]);
  });

  test('addToList and removeFromList', () => {
    userManager.setList('u1', 'lego-minecraft-3', '12, 45, LE8');
    expect(userManager.addToList('u1', 'lego-minecraft-3', '1-3')).toEqual({
      ok: true,
      ids: ids('1', '2', '3', '12', '45', 'LE8'),
    });
    expect(userManager.addToList('u1', 'lego-minecraft-3', '999')).toEqual({
      ok: false,
      reason: 'invalid',
      invalid: ['999'],
    });
    userManager.removeFromList('u1', 'lego-minecraft-3', '45');
    expect(userManager.getList('u1', 'lego-minecraft-3')).toEqual(ids('1', '2', '3', '12', 'LE8'));
  });

  test('removeFromList ignores catalog membership', () => {
    userManager.setList('u1', 'lego-minecraft-3', '12');
    db.delete(cards).run();
    expect(userManager.removeFromList('u1', 'lego-minecraft-3', '12')).toEqual({
      ok: true,
      ids: [],
    });
    expect(userManager.removeFromList('u1', 'lego-minecraft-3', 'abc')).toEqual({
      ok: false,
      reason: 'invalid',
      invalid: ['abc'],
    });
  });

  test('clearList and getList for unknown user', () => {
    expect(userManager.getList('nobody', 'lego-minecraft-3')).toEqual([]);
    userManager.setList('u1', 'lego-minecraft-3', '12');
    userManager.clearList('u1', 'lego-minecraft-3');
    expect(userManager.getList('u1', 'lego-minecraft-3')).toEqual([]);
  });

  test('allWantedIds and usersWanting', () => {
    userManager.setList('u1', 'lego-minecraft-3', '1-3, 12, LE8');
    userManager.setList('u2', 'lego-minecraft-3', '12');
    expect(userManager.allWantedIds()).toEqual(
      new Map([['lego-minecraft-3', new Set(ids('1', '2', '3', '12', 'LE8'))]])
    );
    expect(userManager.usersWanting('lego-minecraft-3', [cid('12'), cid('3')])).toEqual(
      new Map([
        ['u1', ids('3', '12')],
        ['u2', ids('12')],
      ])
    );
    expect(userManager.usersWanting('lego-minecraft-3', [])).toEqual(new Map());
  });

  test('lists stay inside their collection', () => {
    userManager.setList('u1', 'lego-minecraft-3', '12, LE8');
    db.insert(wantedCards)
      .values({ discordId: 'u1', collection: OTHER, cardId: cid('12') })
      .run();
    expect(userManager.allWantedIds()).toEqual(
      new Map([
        ['lego-minecraft-3', new Set(ids('12', 'LE8'))],
        [OTHER, new Set(ids('12'))],
      ])
    );
    expect(userManager.usersWanting(OTHER, [cid('12'), cid('LE8')])).toEqual(
      new Map([['u1', ids('12')]])
    );
    expect(userManager.getList('u1', OTHER)).toEqual(ids('12'));
    userManager.setList('u1', 'lego-minecraft-3', '1');
    expect(userManager.getList('u1', OTHER)).toEqual(ids('12'));
    userManager.addToList('u1', 'lego-minecraft-3', '45');
    expect(userManager.getList('u1', OTHER)).toEqual(ids('12'));
    expect(userManager.getList('u1', 'lego-minecraft-3')).toEqual(ids('1', '45'));
    userManager.removeFromList('u1', 'lego-minecraft-3', '12');
    expect(userManager.getList('u1', OTHER)).toEqual(ids('12'));
    userManager.clearList('u1', 'lego-minecraft-3');
    expect(userManager.getList('u1', 'lego-minecraft-3')).toEqual([]);
    expect(userManager.getList('u1', OTHER)).toEqual(ids('12'));
  });

  test('markDmFailed, hasDmFailure and clearDmFailure', () => {
    userManager.setList('u1', 'lego-minecraft-3', '12');
    userManager.markDmFailed('u1', 1);
    expect(userManager.hasDmFailure('u1')).toBe(true);
    expect(userManager.hasDmFailure('u1')).toBe(true);
    userManager.clearDmFailure('u1');
    expect(userManager.hasDmFailure('u1')).toBe(false);
    expect(userManager.hasDmFailure('nobody')).toBe(false);
  });

  test('empty or separator-only input is rejected and changes nothing', () => {
    userManager.setList('u1', 'lego-minecraft-3', '12, 45');
    expect(userManager.setList('u1', 'lego-minecraft-3', '')).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(userManager.setList('u1', 'lego-minecraft-3', ' ')).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(userManager.addToList('u1', 'lego-minecraft-3', ' , ')).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(userManager.removeFromList('u1', 'lego-minecraft-3', ' , ')).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(userManager.getList('u1', 'lego-minecraft-3')).toEqual(ids('12', '45'));
  });

  test('empty input does not create a user row', () => {
    expect(userManager.setList('u9', 'lego-minecraft-3', '')).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(userManager.addToList('u9', 'lego-minecraft-3', ',')).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(userManager.removeFromList('u9', 'lego-minecraft-3', ',')).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(db.select().from(users).where(eq(users.discordId, 'u9')).all()).toEqual([]);
  });
});
