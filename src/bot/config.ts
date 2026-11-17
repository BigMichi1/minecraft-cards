import { DEFAULT_IMAGE_MATCH_THRESHOLD, DEFAULT_IMAGE_MODEL } from './matcher/embedder';

/**
 * Bot settings read once at startup. Holds secrets (`discordToken`, `ebay.clientSecret`):
 * never log a whole Config object. `DB_PATH`, `MIGRATIONS_PATH` and `LOG_LEVEL` are not here:
 * `database/db.ts` and `utils/logger.ts` read them when they load, before config does.
 */
export interface Config {
  readonly discordToken: string;
  readonly guildId?: string;
  readonly botAdminId: string;
  readonly checkIntervalMs: number;
  /** null when neither EBAY_CLIENT_ID nor EBAY_CLIENT_SECRET is set (eBay off). */
  readonly ebay: Readonly<{ clientId: string; clientSecret: string }> | null;
  readonly imageModel: string;
  readonly imageMatchThreshold: number;
  readonly modelCacheDir: string;
}

/** A missing or invalid environment variable; the message names the variable, never its value. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

const DEFAULT_CHECK_INTERVAL_MINUTES = 60;
/** setInterval takes a 32-bit signed delay; anything longer fires at once, over and over. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_MODEL_CACHE_DIR = './models';

/** The trimmed value, or undefined when unset or blank. */
function optional(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function required(env: Env, name: string): string {
  const value = optional(env, name);
  if (value === undefined) throw new ConfigError(`${name} environment variable is not set`);
  return value;
}

function intervalMs(env: Env): number {
  const raw = optional(env, 'CHECK_INTERVAL_MINUTES');
  if (raw === undefined) return DEFAULT_CHECK_INTERVAL_MINUTES * 60_000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new ConfigError(`CHECK_INTERVAL_MINUTES must be a positive number, got "${raw}"`);
  }
  const ms = Math.round(minutes * 60_000);
  if (ms < 1) {
    throw new ConfigError(
      `CHECK_INTERVAL_MINUTES must be at least 1 millisecond (0.0000167 minutes), got "${raw}"`
    );
  }
  if (ms > MAX_TIMER_MS) {
    throw new ConfigError(
      `CHECK_INTERVAL_MINUTES must be at most ${Math.floor(MAX_TIMER_MS / 60_000)} (about 24 days), got "${raw}"`
    );
  }
  return ms;
}

function threshold(env: Env): number {
  const raw = optional(env, 'IMAGE_MATCH_THRESHOLD');
  if (raw === undefined) return DEFAULT_IMAGE_MATCH_THRESHOLD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new ConfigError(
      `IMAGE_MATCH_THRESHOLD must be a number between 0 and 1 (exclusive), got "${raw}"`
    );
  }
  return value;
}

export function loadConfig(env: Env): Config {
  const discordToken = required(env, 'DISCORD_TOKEN');
  const botAdminId = required(env, 'BOT_ADMIN_ID');
  const guildId = optional(env, 'DISCORD_GUILD_ID');
  const clientId = optional(env, 'EBAY_CLIENT_ID');
  const clientSecret = optional(env, 'EBAY_CLIENT_SECRET');
  if ((clientId === undefined) !== (clientSecret === undefined)) {
    // One without the other is a typo or a missing secret, not "eBay off".
    const [missing, present] =
      clientId === undefined
        ? ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET']
        : ['EBAY_CLIENT_SECRET', 'EBAY_CLIENT_ID'];
    throw new ConfigError(
      `${missing} is not set, but ${present} is: set both to enable eBay, or neither`
    );
  }

  return {
    discordToken,
    ...(guildId === undefined ? {} : { guildId }),
    botAdminId,
    checkIntervalMs: intervalMs(env),
    ebay: clientId && clientSecret ? { clientId, clientSecret } : null,
    imageModel: optional(env, 'IMAGE_MODEL') ?? DEFAULT_IMAGE_MODEL,
    imageMatchThreshold: threshold(env),
    modelCacheDir: optional(env, 'MODEL_CACHE_DIR') ?? DEFAULT_MODEL_CACHE_DIR,
  };
}
