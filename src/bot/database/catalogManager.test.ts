import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, initializeDatabase } from './db';
import { cards, users, wantedCards } from './schema/index';
import { catalogManager, parseKnownCardList } from './catalogManager';
import { parseChecklist, STARTER_CHECKLIST } from '../cards/starterCatalog';
import { cid, ids } from '../../test/cardIds';

const starter = parseChecklist(STARTER_CHECKLIST).ids;
const base228 = starter.filter((id) => /^\d+$/.test(id));
const le1to21 = starter.filter((id) => /^LE\d+$/.test(id) && id !== 'LE22');

function userWanted(discordId: string): string[] {
  return db
    .select()
    .from(wantedCards)
    .where(eq(wantedCards.discordId, discordId))
    .all()
    .map((r) => r.cardId);
}

describe('catalogManager', () => {
  beforeAll(() => {
    initializeDatabase();
  });

  beforeEach(() => {
    db.delete(wantedCards).run();
    db.delete(users).run();
    db.delete(cards).run();
  });

  test('seedIfEmpty seeds the starter catalog once', () => {
    catalogManager.seedIfEmpty();
    expect(catalogManager.knownIds().size).toBe(251);
    catalogManager.seedIfEmpty();
    expect(catalogManager.knownIds().size).toBe(251);
    expect(catalogManager.getCard(cid('LE8'))?.type).toBe('le');
    expect(catalogManager.getCard(cid('XXL1'))?.type).toBe('xxl');
    expect(catalogManager.getCard(cid('12'))?.type).toBe('base');
  });

  test('previewImport and applyImport keep wanted lists untouched', () => {
    catalogManager.seedIfEmpty();
    db.insert(users).values({ discordId: 'u1', createdAt: 1 }).run();
    db.insert(wantedCards)
      .values({ discordId: 'u1', cardId: cid('LE22') })
      .run();

    const next = [...base228, ...le1to21, ...ids('LE23', 'XXL1')];
    const p = catalogManager.previewImport(next);
    expect(p.added).toEqual([cid('LE23')]);
    expect(p.removed).toEqual([cid('LE22')]);
    expect(p.removedStillWanted).toEqual([{ cardId: cid('LE22'), users: 1 }]);
    expect(p.counts).toEqual({ base: 228, le: 22, xxl: 1 });

    catalogManager.applyImport(next);
    expect(catalogManager.knownIds().has(cid('LE22'))).toBe(false);
    expect(catalogManager.knownIds().has(cid('LE23'))).toBe(true);
    expect(userWanted('u1')).toContain('LE22');
  });

  test('a missing picture keeps the stored reference', () => {
    catalogManager.seedIfEmpty();
    catalogManager.updateNamesAndReferences([
      { cardId: cid('12'), name: 'Squid', imageUrl: 'https://x/12.jpg' },
    ]);
    catalogManager.updateNamesAndReferences([
      { cardId: cid('12'), name: 'Squid II', imageUrl: null },
    ]);
    expect(catalogManager.getCard(cid('12'))).toMatchObject({
      name: 'Squid II',
      referenceImageUrl: 'https://x/12.jpg',
    });
  });

  test('parseKnownCardList tells empty input from invalid tokens', () => {
    catalogManager.seedIfEmpty();
    expect(parseKnownCardList(' , ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseKnownCardList('12, x, 999')).toEqual({
      ok: false,
      reason: 'invalid',
      invalid: ['x', '999'],
    });
    expect(parseKnownCardList('999', false)).toEqual({ ok: true, ids: ids('999') });
    expect(parseKnownCardList('LE8, 12')).toEqual({ ok: true, ids: ids('12', 'LE8') });
  });

  test('updateNamesAndReferences only touches catalog ids', () => {
    catalogManager.seedIfEmpty();
    catalogManager.updateNamesAndReferences([
      { cardId: cid('12'), name: 'Squid', imageUrl: 'https://x/12.jpg' },
      { cardId: cid('999'), name: 'Nope', imageUrl: null },
    ]);
    expect(catalogManager.getCard(cid('12'))).toEqual({
      cardId: cid('12'),
      type: 'base',
      name: 'Squid',
      referenceImageUrl: 'https://x/12.jpg',
    });
    expect(catalogManager.getCard(cid('999'))).toBeUndefined();
  });
});
