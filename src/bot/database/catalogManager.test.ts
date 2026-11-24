import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, initializeDatabase } from './db';
import { cards, users, wantedCards } from './schema/index';
import { catalogManager, parseKnownCardList } from './catalogManager';
import { parseChecklist, STARTER_CHECKLIST } from '../cards/starterCatalog';
import { cid, ids } from '../../test/cardIds';
import type { CollectionId } from '../collections/ids';

/** A collection outside the registry, to show reads stay inside their own collection. */
const OTHER = 'other-set' as CollectionId;

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

  test('seedIfEmpty seeds lego-minecraft-3 even when another collection has cards', () => {
    db.insert(cards)
      .values({ collection: OTHER, cardId: cid('12'), type: 'base', name: 'Other', updatedAt: 1 })
      .run();
    catalogManager.seedIfEmpty();
    expect(catalogManager.knownIds('lego-minecraft-3').size).toBe(251);
    expect(catalogManager.knownIds(OTHER)).toEqual(new Set(ids('12')));
  });

  test('reads stay inside their collection', () => {
    catalogManager.seedIfEmpty();
    db.insert(cards)
      .values({
        collection: OTHER,
        cardId: cid('999'),
        type: 'base',
        name: 'Other',
        referenceImageUrl: 'https://o/999.jpg',
        updatedAt: 1,
      })
      .run();
    expect(catalogManager.knownIds('lego-minecraft-3').has(cid('999'))).toBe(false);
    expect(catalogManager.getCard('lego-minecraft-3', cid('999'))).toBeUndefined();
    expect(catalogManager.getCard(OTHER, cid('999'))?.name).toBe('Other');
    expect(catalogManager.cardNames('lego-minecraft-3').has(cid('999'))).toBe(false);
    expect(catalogManager.referenceCatalog('lego-minecraft-3').usable).toEqual([]);
    expect(catalogManager.referenceCatalog(OTHER).usable).toEqual([
      { cardId: cid('999'), referenceImageUrl: 'https://o/999.jpg', puzzle: false },
    ]);
    expect(parseKnownCardList('lego-minecraft-3', '999')).toEqual({
      ok: false,
      reason: 'invalid',
      invalid: ['999'],
    });
    catalogManager.updateNamesAndReferences('lego-minecraft-3', [
      { cardId: cid('999'), name: 'Changed', imageUrl: null },
    ]);
    expect(catalogManager.getCard(OTHER, cid('999'))?.name).toBe('Other');
    catalogManager.applyImport({ collection: 'lego-minecraft-3', ids: ids('1') });
    expect(catalogManager.knownIds(OTHER)).toEqual(new Set(ids('999')));
  });

  test("previewImport counts only the collection's own wanted entries", () => {
    catalogManager.seedIfEmpty();
    db.insert(users).values({ discordId: 'u1', createdAt: 1 }).run();
    db.insert(wantedCards)
      .values({ discordId: 'u1', collection: OTHER, cardId: cid('LE22') })
      .run();
    const p = catalogManager.previewImport({
      collection: 'lego-minecraft-3',
      ids: [...base228, ...le1to21, cid('XXL1')],
    });
    expect(p.removed).toEqual(ids('LE22'));
    expect(p.removedStillWanted).toEqual([]);
  });

  test("a picture another collection also uses is still this collection's reference", () => {
    catalogManager.seedIfEmpty();
    catalogManager.updateNamesAndReferences('lego-minecraft-3', [
      { cardId: cid('12'), name: 'Squid', imageUrl: 'https://shared/12.jpg' },
    ]);
    db.insert(cards)
      .values({
        collection: OTHER,
        cardId: cid('12'),
        type: 'base',
        referenceImageUrl: 'https://shared/12.jpg',
        updatedAt: 1,
      })
      .run();
    expect(catalogManager.referenceCatalog('lego-minecraft-3').usable).toEqual([
      { cardId: cid('12'), referenceImageUrl: 'https://shared/12.jpg', puzzle: false },
    ]);
  });

  test('seedIfEmpty seeds the starter catalog once', () => {
    catalogManager.seedIfEmpty();
    expect(catalogManager.knownIds('lego-minecraft-3').size).toBe(251);
    catalogManager.seedIfEmpty();
    expect(catalogManager.knownIds('lego-minecraft-3').size).toBe(251);
    expect(catalogManager.getCard('lego-minecraft-3', cid('LE8'))?.type).toBe('le');
    expect(catalogManager.getCard('lego-minecraft-3', cid('XXL1'))?.type).toBe('xxl');
    expect(catalogManager.getCard('lego-minecraft-3', cid('12'))?.type).toBe('base');
  });

  test('previewImport and applyImport keep wanted lists untouched', () => {
    catalogManager.seedIfEmpty();
    db.insert(users).values({ discordId: 'u1', createdAt: 1 }).run();
    db.insert(wantedCards)
      .values({ discordId: 'u1', collection: 'lego-minecraft-3', cardId: cid('LE22') })
      .run();

    const next = [...base228, ...le1to21, ...ids('LE23', 'XXL1')];
    const p = catalogManager.previewImport({ collection: 'lego-minecraft-3', ids: next });
    expect(p.added).toEqual([cid('LE23')]);
    expect(p.removed).toEqual([cid('LE22')]);
    expect(p.removedStillWanted).toEqual([{ cardId: cid('LE22'), users: 1 }]);
    expect(p.counts).toEqual({ base: 228, le: 22, xxl: 1 });

    catalogManager.applyImport({ collection: 'lego-minecraft-3', ids: next });
    expect(catalogManager.knownIds('lego-minecraft-3').has(cid('LE22'))).toBe(false);
    expect(catalogManager.knownIds('lego-minecraft-3').has(cid('LE23'))).toBe(true);
    expect(userWanted('u1')).toContain('LE22');
  });

  test('a missing picture keeps the stored reference', () => {
    catalogManager.seedIfEmpty();
    catalogManager.updateNamesAndReferences('lego-minecraft-3', [
      { cardId: cid('12'), name: 'Squid', imageUrl: 'https://x/12.jpg' },
    ]);
    catalogManager.updateNamesAndReferences('lego-minecraft-3', [
      { cardId: cid('12'), name: 'Squid II', imageUrl: null },
    ]);
    expect(catalogManager.getCard('lego-minecraft-3', cid('12'))).toMatchObject({
      name: 'Squid II',
      referenceImageUrl: 'https://x/12.jpg',
    });
  });

  test('parseKnownCardList tells empty input from invalid tokens', () => {
    catalogManager.seedIfEmpty();
    expect(parseKnownCardList('lego-minecraft-3', ' , ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseKnownCardList('lego-minecraft-3', '12, x, 999')).toEqual({
      ok: false,
      reason: 'invalid',
      invalid: ['x', '999'],
    });
    expect(parseKnownCardList('lego-minecraft-3', '999', { checkCatalog: false })).toEqual({
      ok: true,
      ids: ids('999'),
    });
    expect(parseKnownCardList('lego-minecraft-3', 'LE8, 12')).toEqual({
      ok: true,
      ids: ids('12', 'LE8'),
    });
  });

  test('cardNames maps every named catalog card to its name, skipping unnamed ones', () => {
    catalogManager.seedIfEmpty();
    catalogManager.updateNamesAndReferences('lego-minecraft-3', [
      { cardId: cid('131'), name: 'Ghast', imageUrl: null },
      { cardId: cid('LE8'), name: 'Charged Creeper', imageUrl: null },
    ]);
    const names = catalogManager.cardNames('lego-minecraft-3');
    expect(names.get(cid('131'))).toBe('Ghast');
    expect(names.get(cid('LE8'))).toBe('Charged Creeper');
    expect(names.has(cid('1'))).toBe(false);
    expect(names.size).toBe(2);
  });

  test('updateNamesAndReferences only touches catalog ids', () => {
    catalogManager.seedIfEmpty();
    catalogManager.updateNamesAndReferences('lego-minecraft-3', [
      { cardId: cid('12'), name: 'Squid', imageUrl: 'https://x/12.jpg' },
      { cardId: cid('999'), name: 'Nope', imageUrl: null },
    ]);
    expect(catalogManager.getCard('lego-minecraft-3', cid('12'))).toEqual({
      collection: 'lego-minecraft-3',
      cardId: cid('12'),
      type: 'base',
      name: 'Squid',
      referenceImageUrl: 'https://x/12.jpg',
      puzzle: false,
    });
    expect(catalogManager.getCard('lego-minecraft-3', cid('999'))).toBeUndefined();
  });
  test('a card is a puzzle card when its name says "Puzzlekarte", derived on every read (R4)', () => {
    catalogManager.seedIfEmpty();
    expect(catalogManager.getCard('lego-minecraft-3', cid('154'))?.puzzle).toBe(false);
    // Live sammel-ente names of 2026-11-18 ("LEGO Minecraft Serie 3 | #154 Puzzlekarte Oberwelt 1").
    catalogManager.updateNamesAndReferences('lego-minecraft-3', [
      { cardId: cid('154'), name: 'Puzzlekarte Oberwelt 1', imageUrl: null },
      { cardId: cid('189'), name: 'Puzzlekarte Das Ende 9', imageUrl: null },
      { cardId: cid('190'), name: 'Das Wächterduell', imageUrl: null },
      { cardId: cid('12'), name: 'Squid', imageUrl: null },
    ]);
    expect(catalogManager.getCard('lego-minecraft-3', cid('154'))?.puzzle).toBe(true);
    expect(catalogManager.getCard('lego-minecraft-3', cid('189'))?.puzzle).toBe(true);
    expect(catalogManager.getCard('lego-minecraft-3', cid('190'))?.puzzle).toBe(false);
    expect(catalogManager.getCard('lego-minecraft-3', cid('12'))?.puzzle).toBe(false);
  });

  test('a puzzle card stays one when sammel-ente renames it (sticky mark)', () => {
    catalogManager.seedIfEmpty();
    catalogManager.updateNamesAndReferences('lego-minecraft-3', [
      { cardId: cid('154'), name: 'Puzzlekarte Oberwelt 1', imageUrl: 'https://se/154.jpg' },
    ]);
    catalogManager.updateNamesAndReferences('lego-minecraft-3', [
      { cardId: cid('154'), name: 'Oberwelt 1', imageUrl: null },
    ]);
    expect(catalogManager.getCard('lego-minecraft-3', cid('154'))).toMatchObject({
      name: 'Oberwelt 1',
      puzzle: true,
    });
    expect(catalogManager.referenceCatalog('lego-minecraft-3').usable).toEqual([
      { cardId: cid('154'), referenceImageUrl: 'https://se/154.jpg', puzzle: true },
    ]);
  });

  test('a row stored before this release counts as puzzle without a sammel-ente run (R4)', () => {
    db.insert(cards)
      .values({
        collection: 'lego-minecraft-3',
        cardId: cid('160'),
        type: 'base',
        name: 'Puzzlekarte Oberwelt 7',
        updatedAt: 1,
      })
      .run();
    expect(catalogManager.getCard('lego-minecraft-3', cid('160'))?.puzzle).toBe(true);
  });

  test('referenceCatalog: usable references with their puzzle flag, every other card missing', () => {
    catalogManager.seedIfEmpty();
    expect(catalogManager.referenceCatalog('lego-minecraft-3').usable).toEqual([]);
    expect(catalogManager.referenceCatalog('lego-minecraft-3').missing).toHaveLength(251);
    catalogManager.updateNamesAndReferences('lego-minecraft-3', [
      { cardId: cid('12'), name: 'Squid', imageUrl: 'https://se/12.jpg' },
      { cardId: cid('160'), name: 'Puzzlekarte Oberwelt 7', imageUrl: 'https://se/160.jpg' },
      { cardId: cid('13'), name: 'Skeleton', imageUrl: null },
    ]);
    const { usable, missing } = catalogManager.referenceCatalog('lego-minecraft-3');
    expect(usable).toEqual([
      { cardId: cid('12'), referenceImageUrl: 'https://se/12.jpg', puzzle: false },
      { cardId: cid('160'), referenceImageUrl: 'https://se/160.jpg', puzzle: true },
    ]);
    expect(missing).toHaveLength(249);
    expect(missing).toContainEqual({ cardId: cid('13'), reason: 'no_picture' });
  });

  test('updateNamesAndReferences returns the cards whose reference picture changed (R12)', () => {
    catalogManager.seedIfEmpty();
    expect(
      catalogManager.updateNamesAndReferences('lego-minecraft-3', [
        { cardId: cid('12'), name: 'Squid', imageUrl: 'https://se/12.jpg' },
        { cardId: cid('13'), name: 'Skeleton', imageUrl: null },
      ])
    ).toEqual([cid('12')]);
    expect(
      catalogManager.updateNamesAndReferences('lego-minecraft-3', [
        { cardId: cid('12'), name: 'Squid', imageUrl: 'https://se/12.jpg' },
      ])
    ).toEqual([]);
    expect(
      catalogManager.updateNamesAndReferences('lego-minecraft-3', [
        { cardId: cid('12'), name: 'Squid', imageUrl: 'https://se/12b.jpg' },
      ])
    ).toEqual([cid('12')]);
  });

  describe('placeholder references', () => {
    // Live sammel-ente, 2026-11-18: LE10 and LE11 both show the empty card mnc3_leer.jpg.
    const leer =
      'https://shop-sammel-ente.de/media/38/d5/21/1791651554/mnc3_leer.jpg.watermarked.jpg?ts=1791651554';

    test('a "_leer." picture is no reference: missing as a placeholder', () => {
      catalogManager.seedIfEmpty();
      catalogManager.updateNamesAndReferences('lego-minecraft-3', [
        { cardId: cid('LE10'), name: 'Exploding Creeper', imageUrl: leer },
        { cardId: cid('12'), name: 'Squid', imageUrl: 'https://se/mnc3_012.jpg' },
      ]);
      const { usable, missing } = catalogManager.referenceCatalog('lego-minecraft-3');
      expect(usable.map((c) => c.cardId)).toEqual([cid('12')]);
      expect(missing).toContainEqual({ cardId: cid('LE10'), reason: 'placeholder' });
    });

    test('one picture shown for several cards is no reference for any of them', () => {
      catalogManager.seedIfEmpty();
      catalogManager.updateNamesAndReferences('lego-minecraft-3', [
        { cardId: cid('LE10'), name: 'Exploding Creeper', imageUrl: 'https://se/same.jpg?ts=1' },
        { cardId: cid('LE11'), name: 'Iron Golem', imageUrl: 'https://se/same.jpg?ts=2' },
        { cardId: cid('12'), name: 'Squid', imageUrl: 'https://se/mnc3_012.jpg' },
      ]);
      const { usable, missing } = catalogManager.referenceCatalog('lego-minecraft-3');
      expect(usable.map((c) => c.cardId)).toEqual([cid('12')]);
      expect(missing).toContainEqual({ cardId: cid('LE10'), reason: 'shared' });
      expect(missing).toContainEqual({ cardId: cid('LE11'), reason: 'shared' });
    });
  });
});
