import { describe, expect, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { data, execute } from './help';

describe('/help', () => {
  test('is named help', () => {
    expect(data.name).toBe('help');
  });

  test('replies with one ephemeral embed covering /missing', async () => {
    let payload: any;
    const interaction = {
      deferred: false,
      replied: false,
      reply: async (p: unknown) => {
        payload = p;
      },
    } as unknown as ChatInputCommandInteraction;
    await execute(interaction);
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.embeds).toHaveLength(1);
    const text = JSON.stringify(payload.embeds[0].toJSON());
    for (const s of ['/missing', '12, 45, LE8', '20-25', 'wrong', 'DM', 'hour']) {
      expect(text).toContain(s);
    }
  });
});
