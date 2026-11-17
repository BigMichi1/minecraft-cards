/**
 * Measure how well each candidate image model separates "same card" from "different card".
 *
 * Fetches the live blue-ocean and sammel-ente listings, pairs them by card id (true pairs:
 * same card in both shops) and each blue-ocean card with the sammel-ente picture of the next
 * card id both shops have, in sorted order, the last wrapping to the first (false pairs), and
 * prints min / median / max cosine similarity per group and model, the gap between the
 * lowest true pair and the highest false pair, and the errors at the gap midpoint and at the
 * fewest-errors threshold. Pick the model with the widest gap and use its fewest-errors
 * threshold as IMAGE_MATCH_THRESHOLD: the groups overlap, so the midpoint separates nothing.
 *
 * Usage: ./bin/mise run measure:threshold [-- --pages 1|all] [--limit <pairs>]
 *   --pages  `1` reads only the first page of each shop, `all` (default) every page; page 1
 *            alone rarely shares a card id
 *   --limit  cap the number of true pairs (default no cap)
 *
 * Pairs whose pictures cannot be embedded are skipped and counted per model. Exits 1 when no
 * model scored any pair. Downloads the models into MODEL_CACHE_DIR (default ./models) on
 * first use.
 */
import path from 'node:path';

// db.ts opens DB_PATH on import, and Bun loads .env (which may set DB_PATH to the bot's
// database) before this runs: force an in-memory database so the script never touches it.
process.env.DB_PATH = ':memory:';

const { createTransformersEmbedder } = await import('../src/bot/matcher/embedder');
const { cosineSimilarity } = await import('../src/bot/matcher/similarity');
const { createSammelEnteAdapter, parseSammelEntePage } =
  await import('../src/bot/shops/sammelEnte');
const { createBlueOceanAdapter, parseBlueOceanPage } = await import('../src/bot/shops/blueOcean');
const { fetchText } = await import('../src/bot/utils/http');
type Listing = import('../src/bot/shops/types').Listing;

const MODELS = ['Xenova/clip-vit-base-patch32', 'Xenova/dinov2-small'];
const SAMMEL_ENTE_P1 = 'https://shop-sammel-ente.de/Minecraft/Serie-3/?p=1';
const BLUE_OCEAN_P1 =
  'https://www.blue-ocean.de/produkte/lego/lego-minecraft/lego-minecraft-sticker-cards/?p=1';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const pagesArg = argValue('--pages') ?? 'all';
const limit = Number.parseInt(argValue('--limit') ?? '', 10);
const cacheDir = process.env.MODEL_CACHE_DIR || path.join(process.cwd(), 'models');

async function loadListings(): Promise<{ sammel: Listing[]; blue: Listing[] }> {
  if (pagesArg === '1') {
    return {
      sammel: parseSammelEntePage(await fetchText(SAMMEL_ENTE_P1)).listings,
      blue: parseBlueOceanPage(await fetchText(BLUE_OCEAN_P1)).listings,
    };
  }
  if (pagesArg !== 'all') throw new Error(`--pages takes 1 or all, got "${pagesArg}"`);
  return {
    sammel: (await createSammelEnteAdapter().fetchListings()).listings,
    blue: (await createBlueOceanAdapter().fetchListings()).listings,
  };
}

/** Card id → image url, single-card listings with a picture only; blue-ocean id conflicts dropped. */
function imagesById(listings: Listing[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const l of listings) {
    if (l.cardIds.length !== 1 || l.imageUrl === null || l.idConflict) continue;
    map.set(l.cardIds[0]!, l.imageUrl);
  }
  return map;
}

function stats(values: number[]): { min: number; median: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { min: sorted[0]!, median, max: sorted[sorted.length - 1]! };
}

const fmt = (n: number): string => n.toFixed(4);

type Scored = { label: string; sim: number }[];

/** True pairs below `threshold` are missed matches; false pairs at or above it are wrong confirmations. */
function describeErrors(trueSims: Scored, falseSims: Scored, threshold: number): string {
  const missed = trueSims.filter((s) => s.sim < threshold).length;
  const wrong = falseSims.filter((s) => s.sim >= threshold).length;
  return `${missed}/${trueSims.length} true pairs unconfirmed, ${wrong}/${falseSims.length} false pairs confirmed`;
}

/** The threshold (one of the measured values) with the fewest missed plus wrong pairs. */
function fewestErrors(trueSims: Scored, falseSims: Scored): number {
  let best = { threshold: 0, errors: Infinity };
  for (const { sim: t } of [...trueSims, ...falseSims]) {
    const errors =
      trueSims.filter((s) => s.sim < t).length + falseSims.filter((s) => s.sim >= t).length;
    if (errors < best.errors) best = { threshold: t, errors };
  }
  return best.threshold;
}

// The blue-ocean parser already keeps only series 3 ("On Fire") titles.
const { sammel, blue } = await loadListings();
const reference = imagesById(sammel);
const candidates = imagesById(blue);
let ids = [...candidates.keys()].filter((id) => reference.has(id));
ids.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
if (Number.isFinite(limit)) ids = ids.slice(0, limit);
console.log(
  `sammel-ente: ${sammel.length} listings, blue-ocean: ${blue.length} series 3 listings, ` +
    `shared card ids: ${ids.length}`
);
if (ids.length < 2) {
  console.error('need at least two shared card ids to form true and false pairs');
  process.exit(1);
}

// False pair k: blue-ocean card ids[k] against the sammel-ente picture of the next shared id
// ids[k + 1], the last one wrapping to ids[0].
const truePairs = ids.map((id) => ({
  label: id,
  blue: candidates.get(id)!,
  ref: reference.get(id)!,
}));
const falsePairs = ids.map((id, k) => {
  const next = ids[(k + 1) % ids.length]!;
  return { label: `${id}~${next}`, blue: candidates.get(id)!, ref: reference.get(next)! };
});

const results: { model: string; gap: number; fewestErrors: number }[] = [];
for (const model of MODELS) {
  console.log(`\n== ${model}`);
  let embedder;
  try {
    embedder = await createTransformersEmbedder({ model, cacheDir });
  } catch (error) {
    console.log(`model failed to load: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const memo = new Map<string, Promise<Float32Array>>();
  const embed = (url: string): Promise<Float32Array> => {
    if (!memo.has(url)) memo.set(url, embedder.embed(url));
    return memo.get(url)!;
  };
  let skipped = 0;
  const score = async (pairs: typeof truePairs): Promise<{ label: string; sim: number }[]> => {
    const out: { label: string; sim: number }[] = [];
    for (const p of pairs) {
      try {
        out.push({
          label: p.label,
          sim: cosineSimilarity(await embed(p.blue), await embed(p.ref)),
        });
      } catch (error) {
        skipped++;
        console.log(`  skip ${p.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return out;
  };
  const trueSims = await score(truePairs);
  const falseSims = await score(falsePairs);
  console.log(`skipped pairs: ${skipped} of ${truePairs.length + falsePairs.length}`);
  if (trueSims.length === 0 || falseSims.length === 0) {
    console.log('no pair could be scored');
    continue;
  }
  const t = stats(trueSims.map((s) => s.sim));
  const f = stats(falseSims.map((s) => s.sim));
  const gap = t.min - f.max;
  const midpoint = (t.min + f.max) / 2;
  console.log(
    `true  pairs (${trueSims.length}): min ${fmt(t.min)}  median ${fmt(t.median)}  max ${fmt(t.max)}`
  );
  console.log(
    `false pairs (${falseSims.length}): min ${fmt(f.min)}  median ${fmt(f.median)}  max ${fmt(f.max)}`
  );
  console.log(`gap (true min - false max): ${fmt(gap)}  midpoint: ${fmt(midpoint)}`);
  const lowTrue = [...trueSims].sort((a, b) => a.sim - b.sim).slice(0, 3);
  const highFalse = [...falseSims].sort((a, b) => b.sim - a.sim).slice(0, 3);
  console.log(`lowest true:   ${lowTrue.map((s) => `${s.label}=${fmt(s.sim)}`).join(', ')}`);
  console.log(`highest false: ${highFalse.map((s) => `${s.label}=${fmt(s.sim)}`).join(', ')}`);
  console.log(`at the midpoint: ${describeErrors(trueSims, falseSims, midpoint)}`);
  const best = fewestErrors(trueSims, falseSims);
  console.log(`fewest errors at ${fmt(best)}: ${describeErrors(trueSims, falseSims, best)}`);
  results.push({ model, gap, fewestErrors: best });
}

const best = results.sort((a, b) => b.gap - a.gap)[0];
if (!best) {
  console.error('\nno model produced results');
  process.exit(1);
}
console.log(
  `\nwidest gap: ${best.model} (gap ${fmt(best.gap)}, fewest-errors threshold ${fmt(best.fewestErrors)})`
);
if (best.gap <= 0) console.log('warning: the groups overlap; no threshold separates them');
