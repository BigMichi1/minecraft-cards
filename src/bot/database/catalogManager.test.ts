import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, initializeDatabase } from './db';
import { cards, users, wantedCards } from './schema/index';
import { catalogManager } from './catalogManager';
import { parseChecklist, STARTER_CHECKLIST } from '../cards/starterCatalog';

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
    expect(catalogManager.getCard('LE8')?.type).toBe('le');
    expect(catalogManager.getCard('XXL1')?.type).toBe('xxl');
    expect(catalogManager.getCard('12')?.type).toBe('base');
  });

  test('previewImport and applyImport keep wanted lists untouched', () => {
    catalogManager.seedIfEmpty();
    db.insert(users).values({ discordId: 'u1', createdAt: 1 }).run();
    db.insert(wantedCards).values({ discordId: 'u1', cardId: 'LE22' }).run();

    const next = [...base228, ...le1to21, 'LE23', 'XXL1'];
    const p = catalogManager.previewImport(next);
    expect(p.added).toEqual(['LE23']);
    expect(p.removed).toEqual(['LE22']);
    expect(p.removedStillWanted).toEqual([{ cardId: 'LE22', users: 1 }]);
    expect(p.counts).toEqual({ base: 228, le: 22, xxl: 1 });

    catalogManager.applyImport(next);
    expect(catalogManager.knownIds().has('LE22')).toBe(false);
    expect(catalogManager.knownIds().has('LE23')).toBe(true);
    expect(userWanted('u1')).toContain('LE22');
  });

  test('updateNamesAndReferences only touches catalog ids', () => {
    catalogManager.seedIfEmpty();
    catalogManager.updateNamesAndReferences([
      { cardId: '12', name: 'Squid', imageUrl: 'https://x/12.jpg' },
      { cardId: '999', name: 'Nope', imageUrl: null },
    ]);
    expect(catalogManager.getCard('12')).toEqual({
      cardId: '12',
      type: 'base',
      name: 'Squid',
      referenceImageUrl: 'https://x/12.jpg',
    });
    expect(catalogManager.getCard('999')).toBeUndefined();
  });
});
