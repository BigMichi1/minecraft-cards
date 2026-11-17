import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { catalogManager } from '../database/catalogManager';
import { db, initializeDatabase } from '../database/db';
import { cards } from '../database/schema/index';
import { createImportStore, handleCatalogButton } from './catalogImport';
import { cid, ids } from '../../test/cardIds';
import logger from '../utils/logger';

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

  test('a failing save keeps the token, so pressing Save again works', async () => {
    const store = createImportStore(() => clock);
    const token = store.put([cid('1'), cid('2')]);
    const apply = spyOn(catalogManager, 'applyImport').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    try {
      await handleCatalogButton(fakeButton(`catalog-save:${token}`), { adminId: 'admin' }, store);
      expect(replies[0].embeds[0].toJSON().description).toContain('Press Save again');
      await handleCatalogButton(fakeButton(`catalog-save:${token}`), { adminId: 'admin' }, store);
      expect(updates.at(-1).content).toBe('Catalog saved.');
    } finally {
      apply.mockRestore();
    }
  });

  test('a message that cannot be updated after the save is reported as saved, not failed', async () => {
    const store = createImportStore(() => clock);
    const token = store.put([cid('1'), cid('2')]);
    const button = fakeButton(`catalog-save:${token}`);
    (button as unknown as { update: () => Promise<void> }).update = async () => {
      throw new Error('unknown interaction');
    };
    const log = spyOn(logger, 'log');
    try {
      await handleCatalogButton(button, { adminId: 'admin' }, store);
      expect([...catalogManager.knownIds()].sort()).toEqual(ids('1', '2'));
      expect(replies[0].embeds).toBeUndefined();
      expect(replies[0].content).toBe(
        'The catalog was saved, but this message could not be updated.'
      );
      expect(replies[0].flags).toBe(MessageFlags.Ephemeral);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  test('the note goes out as an ephemeral follow-up when the interaction was already answered', async () => {
    const store = createImportStore(() => clock);
    const token = store.put([cid('1')]);
    const button = fakeButton(`catalog-save:${token}`);
    const followUps: any[] = [];
    Object.assign(button, {
      deferred: true,
      update: async () => {
        throw new Error('unknown interaction');
      },
      followUp: async (p: unknown) => {
        followUps.push(p);
      },
    });
    const log = spyOn(logger, 'log');
    try {
      await handleCatalogButton(button, { adminId: 'admin' }, store);
      expect(replies).toEqual([]);
      expect(followUps).toEqual([
        {
          content: 'The catalog was saved, but this message could not be updated.',
          flags: MessageFlags.Ephemeral,
        },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  test('a note that cannot be delivered is logged as a warning and does not become a button failure', async () => {
    const store = createImportStore(() => clock);
    const token = store.put([cid('1')]);
    const button = fakeButton(`catalog-save:${token}`);
    Object.assign(button, {
      update: async () => {
        throw new Error('unknown interaction');
      },
      reply: async () => {
        throw new Error('interaction gone');
      },
    });
    const log = spyOn(logger, 'log');
    const warn = spyOn(logger, 'warn');
    try {
      await handleCatalogButton(button, { adminId: 'admin' }, store);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain('could not be delivered');
      expect(line).not.toContain('failed failed');
      const logged = log.mock.calls.map((c) => String(c[1]));
      expect(logged.some((m) => m.includes('button failed'))).toBe(false);
      expect(replies).toEqual([]);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test('a message that cannot be updated after a cancel is reported as cancelled, not failed', async () => {
    const store = createImportStore(() => clock);
    const token = store.put([cid('1')]);
    const button = fakeButton(`catalog-cancel:${token}`);
    (button as unknown as { update: () => Promise<void> }).update = async () => {
      throw new Error('unknown interaction');
    };
    const log = spyOn(logger, 'log');
    try {
      await handleCatalogButton(button, { adminId: 'admin' }, store);
      expect(replies[0].embeds).toBeUndefined();
      expect(replies[0].content).toBe(
        'The import was cancelled, but this message could not be updated.'
      );
      expect(store.peek(token)).toBeUndefined();
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
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
