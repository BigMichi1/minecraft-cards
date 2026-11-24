import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { ButtonInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { catalogManager } from '../database/catalogManager';
import { db, initializeDatabase } from '../database/db';
import { cards, users, wantedCards } from '../database/schema/index';
import { cid } from '../../test/cardIds';
import { encodeKeepId, encodeRemoveId } from './buttonIds';
import { createRemoveStore, handleCatalogRemove, removeRow } from './catalogRemove';

let clock = 0;
let updates: { content?: string; components?: unknown[] }[] = [];
let replies: { content?: string; flags?: unknown }[] = [];

function fakeButton(customId: string, userId = 'admin') {
  return {
    customId,
    user: { id: userId },
    deferred: false,
    replied: false,
    isChatInputCommand: () => false,
    update: async (p: { content?: string }) => {
      updates.push(p);
    },
    reply: async (p: { content?: string }) => {
      replies.push(p);
    },
  } as unknown as ButtonInteraction;
}

describe('handleCatalogRemove', () => {
  beforeAll(() => initializeDatabase());
  beforeEach(() => {
    for (const t of [wantedCards, users, cards]) db.delete(t).run();
    catalogManager.seedIfEmpty();
    catalogManager.addManual('lego-minecraft-3', cid('229'), 'Extra', null, 1);
    clock = 0;
    updates = [];
    replies = [];
  });
  const deps = { adminId: 'admin' };

  test('the row offers Remove and Keep for the token', () => {
    const ids = removeRow('t1')
      .toJSON()
      .components.map((c) => ('custom_id' in c ? c.custom_id : null));
    expect(ids).toEqual([encodeRemoveId('t1'), encodeKeepId('t1')]);
    expect(ids).toEqual(['catalog-remove:t1', 'catalog-keep:t1']);
  });

  test('Remove deletes the manual card once', async () => {
    const store = createRemoveStore(() => clock);
    const token = store.put('lego-minecraft-3', cid('229'));
    await handleCatalogRemove(fakeButton(`catalog-remove:${token}`), deps, store);
    expect(updates[0]).toEqual({ content: 'Removed #229.', components: [] });
    expect(catalogManager.getCard('lego-minecraft-3', cid('229'))).toBeUndefined();
    await handleCatalogRemove(fakeButton(`catalog-remove:${token}`), deps, store);
    expect(updates[1]!.content).toBe('This removal expired, run the command again.');
  });

  test('Keep, an expired token and another user remove nothing', async () => {
    const store = createRemoveStore(() => clock);
    const keep = store.put('lego-minecraft-3', cid('229'));
    await handleCatalogRemove(fakeButton(`catalog-keep:${keep}`), deps, store);
    expect(updates[0]).toEqual({ content: 'Kept #229.', components: [] });
    const late = store.put('lego-minecraft-3', cid('229'));
    clock += 10 * 60_000;
    await handleCatalogRemove(fakeButton(`catalog-remove:${late}`), deps, store);
    expect(updates[1]!.content).toBe('This removal expired, run the command again.');
    const other = store.put('lego-minecraft-3', cid('229'));
    await handleCatalogRemove(fakeButton(`catalog-remove:${other}`, 'u1'), deps, store);
    expect(replies).toEqual([
      { content: 'Only the bot admin can use this.', flags: MessageFlags.Ephemeral },
    ]);
    expect(catalogManager.getCard('lego-minecraft-3', cid('229'))?.source).toBe('manual');
    // The other user's press did not use the token up.
    await handleCatalogRemove(fakeButton(`catalog-remove:${other}`), deps, store);
    expect(updates.at(-1)!.content).toBe('Removed #229.');
  });

  test('a message that cannot be updated after the removal says the card was removed', async () => {
    const store = createRemoveStore(() => clock);
    const token = store.put('lego-minecraft-3', cid('229'));
    const button = {
      ...fakeButton(`catalog-remove:${token}`),
      update: async () => {
        throw new Error('Unknown interaction');
      },
    } as unknown as ButtonInteraction;
    await handleCatalogRemove(button, deps, store);
    expect(catalogManager.getCard('lego-minecraft-3', cid('229'))).toBeUndefined();
    expect(replies).toEqual([
      {
        content: '#229 was removed, but this message could not be updated.',
        flags: MessageFlags.Ephemeral,
      },
    ]);
  });

  test('a removal that fails before anything changed says so and keeps the card', async () => {
    const store = createRemoveStore(() => clock);
    const token = store.put('lego-minecraft-3', cid('229'));
    const spy = spyOn(catalogManager, 'removeManual').mockImplementation(() => {
      throw new Error('database is locked');
    });
    try {
      await handleCatalogRemove(fakeButton(`catalog-remove:${token}`), deps, store);
    } finally {
      spy.mockRestore();
    }
    expect(catalogManager.getCard('lego-minecraft-3', cid('229'))).toBeDefined();
    expect(JSON.stringify(replies)).toContain('Removing the card failed. Run the command again.');
    expect(JSON.stringify(replies)).not.toContain('was removed');
  });

  test('a kept card whose message cannot be updated says it was kept', async () => {
    const store = createRemoveStore(() => clock);
    const token = store.put('lego-minecraft-3', cid('229'));
    const button = {
      ...fakeButton(`catalog-keep:${token}`),
      update: async () => {
        throw new Error('Unknown interaction');
      },
    } as unknown as ButtonInteraction;
    await handleCatalogRemove(button, deps, store);
    expect(replies).toEqual([
      {
        content: '#229 was kept, but this message could not be updated.',
        flags: MessageFlags.Ephemeral,
      },
    ]);
    expect(catalogManager.getCard('lego-minecraft-3', cid('229'))?.source).toBe('manual');
  });

  test('a card that is no longer manual is not removed, and says why', async () => {
    const store = createRemoveStore(() => clock);
    const token = store.put('lego-minecraft-3', cid('229'));
    catalogManager.markListedNoted('lego-minecraft-3', [cid('229')], 2);
    catalogManager.releaseManual('lego-minecraft-3', cid('229'), 3);
    await handleCatalogRemove(fakeButton(`catalog-remove:${token}`), deps, store);
    expect(updates[0]!.content).toBe(
      '#229 comes from laststicker; only manual cards can be changed here.'
    );
    expect(catalogManager.getCard('lego-minecraft-3', cid('229'))).toBeDefined();
  });
});
