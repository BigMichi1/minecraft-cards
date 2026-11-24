import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, initializeDatabase } from './db';
import { cards, catalogSyncs, users, wantedCards } from './schema/index';
import { userManager } from './userManager';
import { catalogManager, parseKnownCardList } from './catalogManager';
import { parseChecklist, STARTER_CHECKLIST } from '../cards/starterCatalog';
import { cid, ids } from '../../test/cardIds';
import { setCatalogCards } from '../../test/catalog';
import { CatalogLayoutError, type LaststickerRow } from '../catalog/laststicker';
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
    catalogManager.updateReferences('lego-minecraft-3', [
      { cardId: cid('999'), imageUrl: 'https://changed/999.jpg' },
    ]);
    expect(catalogManager.getCard(OTHER, cid('999'))?.referenceImageUrl).toBe('https://o/999.jpg');
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
    catalogManager.updateReferences('lego-minecraft-3', [
      { cardId: cid('12'), imageUrl: 'https://shared/12.jpg' },
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
    catalogManager.updateReferences('lego-minecraft-3', [
      { cardId: cid('12'), imageUrl: 'https://x/12.jpg' },
    ]);
    catalogManager.updateReferences('lego-minecraft-3', [{ cardId: cid('12'), imageUrl: null }]);
    expect(catalogManager.getCard('lego-minecraft-3', cid('12'))?.referenceImageUrl).toBe(
      'https://x/12.jpg'
    );
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
    setCatalogCards('lego-minecraft-3', [
      { cardId: cid('131'), name: 'Ghast' },
      { cardId: cid('LE8'), name: 'Charged Creeper' },
    ]);
    const names = catalogManager.cardNames('lego-minecraft-3');
    expect(names.get(cid('131'))).toBe('Ghast');
    expect(names.get(cid('LE8'))).toBe('Charged Creeper');
    expect(names.has(cid('1'))).toBe(false);
    expect(names.size).toBe(2);
  });

  test('updateReferences writes only pictures, of catalog cards that are not manual', () => {
    catalogManager.seedIfEmpty();
    catalogManager.addManual('lego-minecraft-3', cid('229'), 'Extra', 'https://m/229.jpg', 5);
    catalogManager.updateReferences('lego-minecraft-3', [
      { cardId: cid('12'), imageUrl: 'https://x/12.jpg' },
      { cardId: cid('229'), imageUrl: 'https://x/229.jpg' },
      { cardId: cid('999'), imageUrl: null },
    ]);
    expect(catalogManager.getCard('lego-minecraft-3', cid('12'))).toEqual({
      collection: 'lego-minecraft-3',
      cardId: cid('12'),
      type: 'base',
      name: null,
      kind: null,
      variant: null,
      source: 'laststicker',
      referenceImageUrl: 'https://x/12.jpg',
      puzzle: false,
    });
    expect(catalogManager.getCard('lego-minecraft-3', cid('229'))?.referenceImageUrl).toBe(
      'https://m/229.jpg'
    );
    expect(catalogManager.getCard('lego-minecraft-3', cid('999'))).toBeUndefined();
  });

  test('a puzzle card is one whose stored flag is set; a name alone makes none', () => {
    catalogManager.seedIfEmpty();
    setCatalogCards('lego-minecraft-3', [
      { cardId: cid('154'), name: 'Puzzlekarte Oberwelt 1' },
      { cardId: cid('155'), name: 'The Overworld 2', puzzle: true },
    ]);
    expect(catalogManager.getCard('lego-minecraft-3', cid('154'))?.puzzle).toBe(false);
    expect(catalogManager.getCard('lego-minecraft-3', cid('155'))?.puzzle).toBe(true);
  });

  test('referenceCatalog: usable references with their puzzle flag, every other card missing', () => {
    catalogManager.seedIfEmpty();
    expect(catalogManager.referenceCatalog('lego-minecraft-3').usable).toEqual([]);
    expect(catalogManager.referenceCatalog('lego-minecraft-3').missing).toHaveLength(251);
    catalogManager.updateReferences('lego-minecraft-3', [
      { cardId: cid('12'), imageUrl: 'https://se/12.jpg' },
      { cardId: cid('160'), imageUrl: 'https://se/160.jpg' },
      { cardId: cid('13'), imageUrl: null },
    ]);
    setCatalogCards('lego-minecraft-3', [{ cardId: cid('160'), puzzle: true }]);
    const { usable, missing } = catalogManager.referenceCatalog('lego-minecraft-3');
    expect(usable).toEqual([
      { cardId: cid('12'), referenceImageUrl: 'https://se/12.jpg', puzzle: false },
      { cardId: cid('160'), referenceImageUrl: 'https://se/160.jpg', puzzle: true },
    ]);
    expect(missing).toHaveLength(249);
    expect(missing).toContainEqual({ cardId: cid('13'), reason: 'no_picture' });
  });

  test('updateReferences returns the cards whose reference picture changed (R12)', () => {
    catalogManager.seedIfEmpty();
    expect(
      catalogManager.updateReferences('lego-minecraft-3', [
        { cardId: cid('12'), imageUrl: 'https://se/12.jpg' },
        { cardId: cid('13'), imageUrl: null },
      ])
    ).toEqual([cid('12')]);
    expect(
      catalogManager.updateReferences('lego-minecraft-3', [
        { cardId: cid('12'), imageUrl: 'https://se/12.jpg' },
      ])
    ).toEqual([]);
    expect(
      catalogManager.updateReferences('lego-minecraft-3', [
        { cardId: cid('12'), imageUrl: 'https://se/12b.jpg' },
      ])
    ).toEqual([cid('12')]);
  });

  describe('placeholder references', () => {
    // Live sammel-ente, 2026-11-18: LE10 and LE11 both show the empty card mnc3_leer.jpg.
    const leer =
      'https://shop-sammel-ente.de/media/38/d5/21/1791651554/mnc3_leer.jpg.watermarked.jpg?ts=1791651554';

    test('a "_leer." picture is no reference: missing as a placeholder', () => {
      catalogManager.seedIfEmpty();
      catalogManager.updateReferences('lego-minecraft-3', [
        { cardId: cid('LE10'), imageUrl: leer },
        { cardId: cid('12'), imageUrl: 'https://se/mnc3_012.jpg' },
      ]);
      const { usable, missing } = catalogManager.referenceCatalog('lego-minecraft-3');
      expect(usable.map((c) => c.cardId)).toEqual([cid('12')]);
      expect(missing).toContainEqual({ cardId: cid('LE10'), reason: 'placeholder' });
    });

    test('one picture shown for several cards is no reference for any of them', () => {
      catalogManager.seedIfEmpty();
      catalogManager.updateReferences('lego-minecraft-3', [
        { cardId: cid('LE10'), imageUrl: 'https://se/same.jpg?ts=1' },
        { cardId: cid('LE11'), imageUrl: 'https://se/same.jpg?ts=2' },
        { cardId: cid('12'), imageUrl: 'https://se/mnc3_012.jpg' },
      ]);
      const { usable, missing } = catalogManager.referenceCatalog('lego-minecraft-3');
      expect(usable.map((c) => c.cardId)).toEqual([cid('12')]);
      expect(missing).toContainEqual({ cardId: cid('LE10'), reason: 'shared' });
      expect(missing).toContainEqual({ cardId: cid('LE11'), reason: 'shared' });
    });
  });
  describe('syncCollection', () => {
    const row = (
      id: string,
      name: string,
      kind = 'Characterkarten',
      puzzle = false
    ): LaststickerRow => ({
      cardId: cid(id),
      name,
      kind,
      variant: 'Basis Karte',
      puzzle,
      pictureUrl: `https://www.laststicker.com/i/cards/12125/${id.toLowerCase()}.jpg`,
    });
    const starterRows = () => starter.map((id) => row(id, `Card ${id}`));

    test('a first sync over the starter catalog adds nothing and sets names, kinds and pictures', () => {
      catalogManager.seedIfEmpty();
      const result = catalogManager.syncCollection('lego-minecraft-3', starterRows(), 10);
      expect(result).toEqual({ added: [], renamed: [], vanished: [], nowListed: [] });
      expect(catalogManager.getCard('lego-minecraft-3', cid('LE8'))).toMatchObject({
        name: 'Card LE8',
        kind: 'Characterkarten',
        variant: 'Basis Karte',
        source: 'laststicker',
      });
      expect(catalogManager.laststickerPicture('lego-minecraft-3', cid('LE8'))).toBe(
        'https://www.laststicker.com/i/cards/12125/le8.jpg'
      );
    });

    test('a new id is added, a changed name is listed as renamed', () => {
      catalogManager.seedIfEmpty();
      catalogManager.syncCollection('lego-minecraft-3', starterRows(), 10);
      const next = [
        ...starterRows().filter((r) => r.cardId !== '12'),
        row('12', 'Squid'),
        row('LE23', 'New'),
      ];
      expect(catalogManager.syncCollection('lego-minecraft-3', next, 20)).toEqual({
        added: ids('LE23'),
        renamed: ids('12'),
        vanished: [],
        nowListed: [],
      });
      expect(catalogManager.getCard('lego-minecraft-3', cid('LE23'))).toMatchObject({
        type: 'le',
        name: 'New',
      });
    });

    test('a card the rows lack is kept, still wanted, and reported as vanished', () => {
      catalogManager.seedIfEmpty();
      userManager.setList('u1', 'lego-minecraft-3', '12');
      const rows = starterRows().filter((r) => r.cardId !== '12');
      expect(catalogManager.syncCollection('lego-minecraft-3', rows, 10).vanished).toEqual(
        ids('12')
      );
      expect(catalogManager.knownIds('lego-minecraft-3').size).toBe(251);
      expect(userManager.getList('u1', 'lego-minecraft-3')).toEqual(ids('12'));
    });

    test('Puzzlekarten marks a puzzle card, and a later kind never clears it', () => {
      catalogManager.seedIfEmpty();
      const rows = (kind: string) =>
        starterRows().map((r) => (r.cardId === '154' ? row('154', 'The Overworld 1', kind) : r));
      catalogManager.syncCollection('lego-minecraft-3', rows('Puzzlekarten'), 10);
      expect(catalogManager.getCard('lego-minecraft-3', cid('154'))?.puzzle).toBe(true);
      catalogManager.syncCollection('lego-minecraft-3', rows('Characterkarten'), 20);
      expect(catalogManager.getCard('lego-minecraft-3', cid('154'))).toMatchObject({
        puzzle: true,
        kind: 'Characterkarten',
      });
    });

    test('a manual card the rows list keeps name and picture and is reported until noted', () => {
      catalogManager.seedIfEmpty();
      catalogManager.addManual('lego-minecraft-3', cid('229'), 'Mine', 'https://m/229.jpg', 5);
      const rows = [...starterRows(), row('229', 'Theirs')];
      expect(catalogManager.syncCollection('lego-minecraft-3', rows, 10).nowListed).toEqual(
        ids('229')
      );
      // Not noted yet (the admin's DM may have failed): reported again.
      expect(catalogManager.syncCollection('lego-minecraft-3', rows, 15).nowListed).toEqual(
        ids('229')
      );
      catalogManager.markListedNoted('lego-minecraft-3', ids('229'), 16);
      expect(catalogManager.syncCollection('lego-minecraft-3', rows, 20).nowListed).toEqual([]);
      expect(catalogManager.getCard('lego-minecraft-3', cid('229'))).toMatchObject({
        name: 'Mine',
        referenceImageUrl: 'https://m/229.jpg',
        source: 'manual',
      });
      // A manual card the rows lack is not vanished: it never came from laststicker.
      expect(catalogManager.syncCollection('lego-minecraft-3', starterRows(), 30).vanished).toEqual(
        []
      );
    });

    test('the piece marker alone marks a puzzle card', () => {
      catalogManager.seedIfEmpty();
      const rows = starterRows().map((r) =>
        r.cardId === '154' ? row('154', 'The Overworld 1', 'Puzzles', true) : r
      );
      catalogManager.syncCollection('lego-minecraft-3', rows, 10);
      expect(catalogManager.getCard('lego-minecraft-3', cid('154'))?.puzzle).toBe(true);
    });

    test('rows leaving out more than the tolerance change nothing', () => {
      catalogManager.seedIfEmpty();
      const rows = starterRows().slice(0, 240);
      const sync = (maxVanished: number) =>
        catalogManager.syncCollection('lego-minecraft-3', rows, 10, { maxVanished });
      expect(() => sync(5)).toThrow(CatalogLayoutError);
      expect(() => sync(5)).toThrow(
        '11 stored cards missing from laststicker, more than 5: LE13, LE14, LE15'
      );
      expect(catalogManager.getCard('lego-minecraft-3', cid('1'))?.name).toBeNull();
      expect(sync(11).vanished).toHaveLength(11);
    });

    test('a released card is taken over by the next sync', () => {
      catalogManager.seedIfEmpty();
      catalogManager.addManual('lego-minecraft-3', cid('229'), 'Mine', 'https://m/229.jpg', 5);
      const rows = [...starterRows(), row('229', 'Theirs')];
      catalogManager.syncCollection('lego-minecraft-3', rows, 10);
      catalogManager.markListedNoted('lego-minecraft-3', ids('229'), 11);
      expect(catalogManager.releaseManual('lego-minecraft-3', cid('229'), 12)).toEqual({
        ok: true,
      });
      const result = catalogManager.syncCollection('lego-minecraft-3', rows, 20);
      expect(result.renamed).toEqual(ids('229'));
      expect(result.nowListed).toEqual([]);
      expect(catalogManager.getCard('lego-minecraft-3', cid('229'))).toMatchObject({
        name: 'Theirs',
        kind: 'Characterkarten',
        source: 'laststicker',
        // The admin's picture stays until a sammel-ente run gives one.
        referenceImageUrl: 'https://m/229.jpg',
      });
      expect(
        catalogManager.updateReferences('lego-minecraft-3', [
          { cardId: cid('229'), imageUrl: 'https://se/229.jpg' },
        ])
      ).toEqual(ids('229'));
    });

    test("another collection's cards are untouched", () => {
      catalogManager.seedIfEmpty();
      db.insert(cards)
        .values({ collection: OTHER, cardId: cid('12'), type: 'base', name: 'Other', updatedAt: 1 })
        .run();
      catalogManager.syncCollection('lego-minecraft-3', starterRows(), 10);
      expect(catalogManager.getCard(OTHER, cid('12'))?.name).toBe('Other');
    });
  });

  describe('manual cards', () => {
    test('add stores a manual card; an existing id is refused', () => {
      catalogManager.seedIfEmpty();
      expect(catalogManager.addManual('lego-minecraft-3', cid('LE23'), 'Extra', null, 5)).toEqual({
        ok: true,
      });
      expect(catalogManager.getCard('lego-minecraft-3', cid('LE23'))).toMatchObject({
        type: 'le',
        name: 'Extra',
        source: 'manual',
        referenceImageUrl: null,
      });
      expect(catalogManager.addManual('lego-minecraft-3', cid('12'), 'X', null, 5)).toEqual({
        ok: false,
        reason: 'exists',
      });
    });

    test('release needs laststicker to list the card', () => {
      catalogManager.seedIfEmpty();
      catalogManager.addManual('lego-minecraft-3', cid('229'), 'Extra', null, 5);
      expect(catalogManager.releaseManual('lego-minecraft-3', cid('229'), 6)).toEqual({
        ok: false,
        reason: 'not_listed',
      });
      expect(catalogManager.getCard('lego-minecraft-3', cid('229'))?.source).toBe('manual');
    });

    test('manualCard reads a manual card, or says why not', () => {
      catalogManager.seedIfEmpty();
      catalogManager.addManual('lego-minecraft-3', cid('229'), 'Extra', null, 5);
      expect(catalogManager.manualCard('lego-minecraft-3', cid('229'))).toMatchObject({
        ok: true,
        card: { name: 'Extra', source: 'manual' },
      });
      expect(catalogManager.manualCard('lego-minecraft-3', cid('12'))).toEqual({
        ok: false,
        reason: 'not_manual',
      });
      expect(catalogManager.manualCard('lego-minecraft-3', cid('999'))).toEqual({
        ok: false,
        reason: 'unknown',
      });
    });

    test('laststickerCardCount counts only laststicker cards', () => {
      catalogManager.seedIfEmpty();
      catalogManager.addManual('lego-minecraft-3', cid('229'), 'Extra', null, 5);
      expect(catalogManager.laststickerCardCount('lego-minecraft-3')).toBe(251);
    });

    test('a manual card without a picture takes the sammel-ente one, then keeps it', () => {
      catalogManager.seedIfEmpty();
      catalogManager.addManual('lego-minecraft-3', cid('229'), 'Extra', null, 5);
      catalogManager.updateReferences('lego-minecraft-3', [
        { cardId: cid('229'), imageUrl: 'https://se/229.jpg' },
      ]);
      catalogManager.updateReferences('lego-minecraft-3', [
        { cardId: cid('229'), imageUrl: 'https://se/229-new.jpg' },
      ]);
      expect(catalogManager.getCard('lego-minecraft-3', cid('229'))?.referenceImageUrl).toBe(
        'https://se/229.jpg'
      );
    });

    test('a catalog import never removes a manual card', () => {
      catalogManager.seedIfEmpty();
      catalogManager.addManual('lego-minecraft-3', cid('229'), 'Extra', null, 5);
      const preview = catalogManager.previewImport({
        collection: 'lego-minecraft-3',
        ids: starter,
      });
      expect(preview.removed).toEqual([]);
      expect(preview.keptManual).toEqual(ids('229'));
      catalogManager.applyImport({ collection: 'lego-minecraft-3', ids: starter });
      expect(catalogManager.getCard('lego-minecraft-3', cid('229'))?.source).toBe('manual');
    });

    test('edit, remove and release act on manual cards only', () => {
      catalogManager.seedIfEmpty();
      catalogManager.addManual('lego-minecraft-3', cid('229'), 'Extra', null, 5);
      expect(
        catalogManager.editManual(
          'lego-minecraft-3',
          cid('229'),
          { pictureUrl: 'https://m/1.jpg' },
          6
        )
      ).toEqual({ ok: true });
      expect(catalogManager.getCard('lego-minecraft-3', cid('229'))).toMatchObject({
        name: 'Extra',
        referenceImageUrl: 'https://m/1.jpg',
      });
      const notManual = { ok: false, reason: 'not_manual' } as const;
      const unknown = { ok: false, reason: 'unknown' } as const;
      expect(catalogManager.editManual('lego-minecraft-3', cid('12'), { name: 'X' }, 6)).toEqual(
        notManual
      );
      expect(catalogManager.removeManual('lego-minecraft-3', cid('12'))).toEqual(notManual);
      expect(catalogManager.releaseManual('lego-minecraft-3', cid('12'), 6)).toEqual(notManual);
      expect(catalogManager.removeManual('lego-minecraft-3', cid('999'))).toEqual(unknown);
      expect(catalogManager.releaseManual('lego-minecraft-3', cid('229'), 7)).toEqual({
        ok: false,
        reason: 'not_listed',
      });
    });

    test('remove deletes the card but keeps it on wanted lists; wantedCount counts users', () => {
      catalogManager.seedIfEmpty();
      catalogManager.addManual('lego-minecraft-3', cid('229'), 'Extra', null, 5);
      userManager.setList('u1', 'lego-minecraft-3', '229');
      userManager.setList('u2', 'lego-minecraft-3', '229, 12');
      expect(catalogManager.wantedCount('lego-minecraft-3', cid('229'))).toBe(2);
      expect(catalogManager.removeManual('lego-minecraft-3', cid('229'))).toEqual({ ok: true });
      expect(catalogManager.getCard('lego-minecraft-3', cid('229'))).toBeUndefined();
      expect(userManager.getList('u1', 'lego-minecraft-3')).toEqual(ids('229'));
    });
  });

  describe('catalog sync times', () => {
    test('attempt and success are recorded per collection', () => {
      db.delete(catalogSyncs).run();
      expect(catalogManager.syncAttemptedAt('lego-minecraft-3')).toBeUndefined();
      catalogManager.markSyncAttempt('lego-minecraft-3', 10);
      catalogManager.markSyncAttempt('lego-minecraft-3', 20);
      expect(catalogManager.syncAttemptedAt('lego-minecraft-3')).toBe(20);
      catalogManager.markSyncSuccess('lego-minecraft-3', 25);
      expect(db.select().from(catalogSyncs).all()).toEqual([
        { collection: 'lego-minecraft-3', attemptedAt: 20, succeededAt: 25 },
      ]);
      // A later failed attempt keeps the last success.
      catalogManager.markSyncAttempt('lego-minecraft-3', 30);
      expect(catalogManager.syncSucceededAt('lego-minecraft-3')).toBe(25);
      expect(catalogManager.syncAttemptedAt('lego-minecraft-3')).toBe(30);
    });
  });
});
