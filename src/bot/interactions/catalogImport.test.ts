import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ButtonInteraction } from 'discord.js';
import { catalogManager } from '../database/catalogManager';
import { db, initializeDatabase } from '../database/db';
import { cards } from '../database/schema/index';
import { createImportStore, handleCatalogButton } from './catalogImport';
import { cid, ids } from '../../test/cardIds';

let clock = 0;
let updates: any[] = [];
let replies: any[] = [];

function fakeButton(customId: string, userId = 'admin') {
  return {
    customId,
    user: { id: userId },
    deferred: false,
    replied: false,
    isChatInputCommand: () => false,
    update: async (p: unknown) => {
      updates.push(p);
    },
    reply: async (p: unknown) => {
      replies.push(p);
    },
  } as unknown as ButtonInteraction;
}

describe('import store', () => {
  test('take returns once and consumes the token', () => {
    const store = createImportStore(() => clock);
    const token = store.put([cid('1')]);
    expect(store.take(token)).toEqual(ids('1'));
    expect(store.take(token)).toBeUndefined();
  });

  test('tokens expire after 10 minutes', () => {
    clock = 0;
    const store = createImportStore(() => clock);
    const token = store.put([cid('1')]);
    clock += 11 * 60_000;
    expect(store.take(token)).toBeUndefined();
  });

  test('unknown token yields undefined', () => {
    expect(createImportStore(() => 0).take('nope')).toBeUndefined();
  });
});

describe('handleCatalogButton', () => {
  beforeAll(() => {
    initializeDatabase();
  });
  beforeEach(() => {
    clock = 0;
    updates = [];
    replies = [];
    db.delete(cards).run();
    catalogManager.seedIfEmpty();
  });

  test('save applies the import once', async () => {
    const store = createImportStore(() => clock);
    const token = store.put([cid('1'), cid('2')]);
    await handleCatalogButton(fakeButton(`catalog-save:${token}`), { adminId: 'admin' }, store);
    expect(updates[0].content).toBe('Catalog saved.');
    expect([...catalogManager.knownIds()].sort()).toEqual(ids('1', '2'));
    await handleCatalogButton(fakeButton(`catalog-save:${token}`), { adminId: 'admin' }, store);
    expect(updates[1].content).toBe('This import expired, run the command again.');
  });

  test('cancel stores nothing', async () => {
    const store = createImportStore(() => clock);
    const token = store.put([cid('1')]);
    await handleCatalogButton(fakeButton(`catalog-cancel:${token}`), { adminId: 'admin' }, store);
    expect(updates[0].content).toBe('Import cancelled.');
    expect(catalogManager.knownIds().size).toBeGreaterThan(200);
  });

  test('an expired token is reported', async () => {
    const store = createImportStore(() => clock);
    const token = store.put([cid('1')]);
    clock += 11 * 60_000;
    await handleCatalogButton(fakeButton(`catalog-save:${token}`), { adminId: 'admin' }, store);
    expect(updates[0].content).toBe('This import expired, run the command again.');
  });

  test('a non-admin cannot save and does not consume the token', async () => {
    const store = createImportStore(() => clock);
    const token = store.put([cid('1')]);
    await handleCatalogButton(
      fakeButton(`catalog-save:${token}`, 'u1'),
      { adminId: 'admin' },
      store
    );
    expect(replies[0].content).toBe('Only the bot admin can use this.');
    expect(catalogManager.knownIds().size).toBeGreaterThan(200);
    expect(store.take(token)).toEqual(ids('1'));
  });
});
