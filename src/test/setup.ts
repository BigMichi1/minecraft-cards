/**
 * Bun test preload: runs in each worker before any test file is evaluated.
 * Points the database at in-memory SQLite and the migrator at the real folder.
 */
import path from 'path';

process.env.DB_PATH = ':memory:';
process.env.MIGRATIONS_PATH = path.join(process.cwd(), 'src/bot/database/migrations');
process.env.BOT_ADMIN_ID = '100';
process.env.DISCORD_TOKEN = 'test';
