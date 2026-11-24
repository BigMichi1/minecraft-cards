import { describe, expect, test } from 'bun:test';
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

  test('names the refusal', () => {
    expect(UNKNOWN_COLLECTION).toBe('Unknown collection.');
  });
});
