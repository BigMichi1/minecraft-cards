import { describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { collectionOption, readCollection, UNKNOWN_COLLECTION } from './collectionOption';

function withCollection(value: string | null) {
  return {
    options: { getString: (name: string) => (name === 'collection' ? value : null) },
  } as unknown as ChatInputCommandInteraction;
}

describe('collectionOption', () => {
  test('is a required string option offering every collection', () => {
    const json = new SlashCommandBuilder()
      .setName('x')
      .setDescription('x')
      .addStringOption(collectionOption)
      .toJSON();
    expect(json.options).toEqual([
      expect.objectContaining({
        name: 'collection',
        description: 'Card collection',
        required: true,
        choices: [{ name: 'LEGO Minecraft Serie 3 "On Fire"', value: 'lego-minecraft-3' }],
      }),
    ]);
  });
});

describe('readCollection', () => {
  test('returns a registered collection', () => {
    expect(readCollection(withCollection('lego-minecraft-3'))).toBe('lego-minecraft-3');
  });

  test('returns null for a value outside the registry or a missing option', () => {
    expect(readCollection(withCollection('lego-minecraft-9'))).toBeNull();
    expect(readCollection(withCollection(null))).toBeNull();
  });

  test('the refusal says what to do and names the collections', () => {
    expect(UNKNOWN_COLLECTION).toBe(
      'Unknown collection. Discord may show an outdated command: reopen Discord and pick one of: LEGO Minecraft Serie 3 "On Fire".'
    );
  });

  test('a refused value is logged with the command, so stale registrations show up', () => {
    const warn = spyOn(logger, 'warn');
    try {
      const i = { ...withCollection('lego-minecraft-9'), commandName: 'stock' };
      expect(readCollection(i as unknown as ChatInputCommandInteraction)).toBeNull();
      const missing = { ...withCollection(null), commandName: 'card' };
      expect(readCollection(missing as unknown as ChatInputCommandInteraction)).toBeNull();
      expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
        '[COLLECTION] /stock: unknown collection "lego-minecraft-9" (an outdated command?)',
        '[COLLECTION] /card: no collection (an outdated command?)',
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
