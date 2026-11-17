import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { db, initializeDatabase } from '../database/db';
import { cards, users, wantedCards } from '../database/schema/index';
import { catalogManager } from '../database/catalogManager';
import { execute, data } from './missing';

let replies: Array<{ content?: string; flags?: unknown }> = [];

function fakeInteraction(userId: string, sub: string, list?: string) {
  return {
    user: { id: userId },
    deferred: false,
    replied: false,
    commandName: 'missing',
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => sub,
      getString: (_name: string) => list ?? null,
    },
    reply: async (payload: { content?: string; flags?: unknown }) => {
      replies.push(payload);
    },
  } as unknown as ChatInputCommandInteraction;
}

const lastReply = () => replies[replies.length - 1]!;

describe('/missing', () => {
  beforeAll(() => {
    initializeDatabase();
  });

  beforeEach(() => {
    replies = [];
    db.delete(wantedCards).run();
    db.delete(users).run();
    db.delete(cards).run();
    catalogManager.seedIfEmpty();
  });

  test('declares the five subcommands with max_length 6000 on list', () => {
    const json = data.toJSON();
    expect(json.options?.map((o) => o.name)).toEqual(['set', 'add', 'remove', 'list', 'clear']);
    const set = json.options![0] as { options: Array<{ max_length?: number }> };
    expect(set.options[0]!.max_length).toBe(6000);
  });

  test('set replies with the new list, ephemeral', async () => {
    await execute(fakeInteraction('u1', 'set', '12, 45'));
    expect(lastReply().content).toBe('Your missing cards (2): 12, 45');
    expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
  });

  test('add with an unknown token changes nothing and names it', async () => {
    await execute(fakeInteraction('u1', 'set', '12, 45'));
    await execute(fakeInteraction('u1', 'add', '12, 9999'));
    expect(lastReply().content).toBe('Nothing changed. Unknown or invalid: 9999');
    expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
    await execute(fakeInteraction('u1', 'list'));
    expect(lastReply().content).toBe('Your missing cards (2): 12, 45');
  });

  test('add and remove update the list', async () => {
    await execute(fakeInteraction('u1', 'set', '12'));
    await execute(fakeInteraction('u1', 'add', '45, LE8'));
    expect(lastReply().content).toBe('Your missing cards (3): 12, 45, LE8');
    await execute(fakeInteraction('u1', 'remove', '12'));
    expect(lastReply().content).toBe('Your missing cards (2): 45, LE8');
  });

  test('empty or separator-only input gets the example hint', async () => {
    await execute(fakeInteraction('u1', 'set', ' , '));
    expect(lastReply().content).toBe('No card numbers found. Example: 12, 45, LE8');
    expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
  });

  test('list on an empty list and clear', async () => {
    await execute(fakeInteraction('u1', 'list'));
    expect(lastReply().content).toBe('You have no missing cards on your list.');
    await execute(fakeInteraction('u1', 'set', '12'));
    await execute(fakeInteraction('u1', 'clear'));
    expect(lastReply().content).toBe('Your missing list is now empty.');
    expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
    await execute(fakeInteraction('u1', 'list'));
    expect(lastReply().content).toBe('You have no missing cards on your list.');
  });
});
