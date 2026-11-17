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
        // Read by database/db.ts when it loads, not part of Config.
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
      checkIntervalMs: 900_000,
      ebay: { clientId: 'id', clientSecret: 'secret' },
      imageModel: 'Xenova/clip-vit-base-patch32',
      imageMatchThreshold: 0.9,
      modelCacheDir: '/models',
    });
  });

  test('only one eBay credential is a configuration error naming the missing one', () => {
    expect(() => loadConfig({ ...REQUIRED, EBAY_CLIENT_ID: 'id' })).toThrow(
      /^EBAY_CLIENT_SECRET is not set/
    );
    expect(() => loadConfig({ ...REQUIRED, EBAY_CLIENT_SECRET: 's' })).toThrow(
      /^EBAY_CLIENT_ID is not set/
    );
    expect(() => loadConfig({ ...REQUIRED, EBAY_CLIENT_SECRET: 's' })).toThrow(ConfigError);
  });

  test('neither eBay credential disables eBay', () => {
    expect(
      loadConfig({ ...REQUIRED, EBAY_CLIENT_ID: ' ', EBAY_CLIENT_SECRET: '' }).ebay
    ).toBeNull();
  });

  test('rejects an interval longer than a timer can wait', () => {
    // 2^31 - 1 ms is about 35791 minutes; longer makes setInterval fire every millisecond.
    expect(loadConfig({ ...REQUIRED, CHECK_INTERVAL_MINUTES: '35791' }).checkIntervalMs).toBe(
      2_147_460_000
    );
    expect(() => loadConfig({ ...REQUIRED, CHECK_INTERVAL_MINUTES: '35792' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...REQUIRED, CHECK_INTERVAL_MINUTES: '1e9' })).toThrow(
      'CHECK_INTERVAL_MINUTES'
    );
  });

  test('rejects an interval that rounds to zero milliseconds', () => {
    expect(() => loadConfig({ ...REQUIRED, CHECK_INTERVAL_MINUTES: '0.000001' })).toThrow(
      ConfigError
    );
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
        EBAY_CLIENT_ID: 'ebay-id',
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
