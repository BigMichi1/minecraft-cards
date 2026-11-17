/**
 * Download IMAGE_MODEL (default DEFAULT_IMAGE_MODEL) into MODEL_CACHE_DIR (default ./models),
 * so the bot can start offline. Loading the pipeline once fetches every file it needs.
 *
 * Usage: ./bin/mise run model:download
 */
import path from 'node:path';

// db.ts opens DB_PATH on import, and Bun loads .env (which may set DB_PATH to the bot's
// database) before this runs: force an in-memory database so the script never touches it.
process.env.DB_PATH = ':memory:';

const { createTransformersEmbedder, DEFAULT_IMAGE_MODEL } =
  await import('../src/bot/matcher/embedder');

const model = process.env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
const cacheDir = process.env.MODEL_CACHE_DIR || path.join(process.cwd(), 'models');

console.log(`downloading ${model} into ${cacheDir}`);
try {
  await createTransformersEmbedder({ model, cacheDir });
} catch (error) {
  console.error(`failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
console.log('done');
