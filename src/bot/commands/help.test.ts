import { describe, expect, spyOn, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import logger from '../utils/logger';
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
    for (const s of [
      '/missing',
      '/missing status collection:<c>',
      '/stock',
      'only:missing',
      '/card collection:<c> number:<id>',
      '/missing set collection:<c> list:<cards>',
      'LEGO Minecraft Serie 3 \\"On Fire\\"',
      'shop:',
      '12, 45, LE8',
      '20-25',
      'wrong',
      'DM',
      'hour',
    ]) {
      expect(text).toContain(s);
    }
  });

  test('a reply Discord rejects gets the error reply and is logged', async () => {
    const payloads: any[] = [];
    let calls = 0;
    const interaction = {
      deferred: false,
      replied: false,
      isChatInputCommand: () => true,
      commandName: 'help',
      reply: async (p: unknown) => {
        calls++;
        if (calls === 1) throw new Error('Invalid Form Body');
        payloads.push(p);
      },
    } as unknown as ChatInputCommandInteraction;
    const log = spyOn(logger, 'log').mockImplementation(() => logger);
    try {
      await execute(interaction);
      expect(log.mock.calls.some((c: unknown[]) => String(c[1]).includes('[HELP COMMAND]'))).toBe(
        true
      );
    } finally {
      log.mockRestore();
    }
    expect(payloads[0].embeds[0].toJSON().description).toBe(
      'An error occurred while displaying help.'
    );
  });
});
