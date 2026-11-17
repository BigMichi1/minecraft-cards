import { describe, expect, test } from 'bun:test';
import { ConfigError, loadConfig } from './config';
import { DEFAULT_IMAGE_MATCH_THRESHOLD, DEFAULT_IMAGE_MODEL } from './matcher/embedder';

const REQUIRED = { DISCORD_TOKEN: 't', BOT_ADMIN_ID: '1' };

describe('loadConfig', () => {
  test('requires DISCORD_TOKEN', () => {
    expect(() => loadConfig({ BOT_ADMIN_ID: '1' })).toThrow('DISCORD_TOKEN');
    expect(() => loadConfig({ BOT_ADMIN_ID: '1' })).toThrow(ConfigError);
  });

  test('requires BOT_ADMIN_ID', () => {
    expect(() => loadConfig({ DISCORD_TOKEN: 't' })).toThrow('BOT_ADMIN_ID');
  });

  test('treats blank values as unset', () => {
    expect(() => loadConfig({ DISCORD_TOKEN: '  ', BOT_ADMIN_ID: '1' })).toThrow('DISCORD_TOKEN');
  });

  test('applies defaults', () => {
    expect(loadConfig(REQUIRED)).toEqual({
      discordToken: 't',
      botAdminId: '1',
      dbPath: './data/cards.db',
      checkIntervalMs: 3_600_000,
      ebay: null,
      imageModel: DEFAULT_IMAGE_MODEL,
      imageMatchThreshold: DEFAULT_IMAGE_MATCH_THRESHOLD,
      modelCacheDir: './models',
    });
  });

  test('reads every optional variable', () => {
    expect(
      loadConfig({
        ...REQUIRED,
        DISCORD_GUILD_ID: '42',
        DB_PATH: '/tmp/x.db',
        CHECK_INTERVAL_MINUTES: '15',
        EBAY_CLIENT_ID: 'id',
        EBAY_CLIENT_SECRET: 'secret',
        IMAGE_MODEL: 'Xenova/clip-vit-base-patch32',
        IMAGE_MATCH_THRESHOLD: '0.9',
        MODEL_CACHE_DIR: '/models',
      })
    ).toEqual({
      discordToken: 't',
      guildId: '42',
      botAdminId: '1',
      dbPath: '/tmp/x.db',
      checkIntervalMs: 900_000,
      ebay: { clientId: 'id', clientSecret: 'secret' },
      imageModel: 'Xenova/clip-vit-base-patch32',
      imageMatchThreshold: 0.9,
      modelCacheDir: '/models',
    });
  });

  test('disables eBay when only one credential is set', () => {
    expect(loadConfig({ ...REQUIRED, EBAY_CLIENT_ID: 'id' }).ebay).toBeNull();
    expect(loadConfig({ ...REQUIRED, EBAY_CLIENT_SECRET: 's' }).ebay).toBeNull();
  });

  test.each(['abc', '0', '-5', '1.5x'])('rejects CHECK_INTERVAL_MINUTES=%p', (value) => {
    expect(() => loadConfig({ ...REQUIRED, CHECK_INTERVAL_MINUTES: value })).toThrow(
      'CHECK_INTERVAL_MINUTES'
    );
  });

  test('accepts a fractional CHECK_INTERVAL_MINUTES', () => {
    expect(loadConfig({ ...REQUIRED, CHECK_INTERVAL_MINUTES: '0.5' }).checkIntervalMs).toBe(30_000);
  });

  test('uses the default interval for a blank CHECK_INTERVAL_MINUTES', () => {
    expect(loadConfig({ ...REQUIRED, CHECK_INTERVAL_MINUTES: '' }).checkIntervalMs).toBe(3_600_000);
  });

  test.each(['2', '0', '1', '-0.1', 'abc'])('rejects IMAGE_MATCH_THRESHOLD=%p', (value) => {
    expect(() => loadConfig({ ...REQUIRED, IMAGE_MATCH_THRESHOLD: value })).toThrow(
      'IMAGE_MATCH_THRESHOLD'
    );
  });

  test('error messages never contain secret values', () => {
    try {
      loadConfig({
        DISCORD_TOKEN: 'super-secret-token',
        BOT_ADMIN_ID: '1',
        EBAY_CLIENT_SECRET: 'ebay-secret',
        IMAGE_MATCH_THRESHOLD: '7',
      });
      throw new Error('expected loadConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(String(error)).not.toContain('super-secret-token');
      expect(String(error)).not.toContain('ebay-secret');
    }
  });
});
