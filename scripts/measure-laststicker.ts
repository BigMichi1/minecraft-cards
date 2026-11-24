/**
 * Measure laststicker's scans as image references (multi-collection step 2, before the switch).
 *
 * Reads the series 3 laststicker set and the single-card listings of sammel-ente, collect-it
 * and, when EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are set, eBay (titles naming one card). Per
 * shop it prints the cosine similarity of each listing picture with the scan of its own card
 * (true pairs) and with the scan of the next card id that shop has (false pairs, usually the
 * neighbouring panorama piece), min / median / max, the errors at IMAGE_MATCH_THRESHOLD and the
 * fewest-errors threshold. Then every picture is identified against all scans (identifyPicture,
 * the bot's rules 1 to 5 input) and the decided / right / wrong counts are printed, and every pair
 * of references (fallbacks included) at least TWIN_SIMILARITY alike.
 *
 * Usage: ./bin/mise run measure:laststicker [-- --collection lego-minecraft-1]
 *   --collection  the collection (default lego-minecraft-3): its set, its sammel-ente and
 *                 collect-it categories, eBay for series 3 only
 *
 * Scans are downloaded at most one per 1500 ms (laststicker's pacing); a scan that cannot be
 * loaded (404: no scan) is listed, and sammel-ente's picture of that card stands in
 * (referenceFallbackShop), as referenceCatalog chooses it. The placeholder, shared and
 * knownTwins rules are not applied. Uses DEFAULT_IMAGE_MODEL from MODEL_CACHE_DIR
 * (default ./models). Exits 1 when no pair could be scored.
 */
import path from 'node:path';

// db.ts opens DB_PATH on import, and Bun loads .env (which may set DB_PATH to the bot's
// database) before this runs: force an in-memory database so the script never touches it.
process.env.DB_PATH = ':memory:';

const { createTransformersEmbedder, DEFAULT_IMAGE_MATCH_THRESHOLD, DEFAULT_IMAGE_MODEL } =
  await import('../src/bot/matcher/embedder');
const { cosineSimilarity } = await import('../src/bot/matcher/similarity');
const { identifyPicture, TWIN_SIMILARITY, DECISION_GAP } =
  await import('../src/bot/matcher/identify');
const { fetchLaststickerSet } = await import('../src/bot/catalog/laststicker');
const { createSammelEnteFetcher } = await import('../src/bot/shops/sammelEnte');
const { createCollectItFetcher } = await import('../src/bot/shops/collectIt');
const { createEbayFetcher } = await import('../src/bot/shops/ebay');
const { sleep } = await import('../src/bot/utils/async');
type Listing = import('../src/bot/shops/types').Listing;
type ReferenceVector = import('../src/bot/matcher/identify').ReferenceVector;
type CardId = import('../src/bot/cards/cardId').CardId;

const { collectionById } = await import('../src/bot/collections/index');
type CollectionId = import('../src/bot/collections/ids').CollectionId;
const argAt = process.argv.indexOf('--collection');
const definition = collectionById(
  (argAt === -1 ? 'lego-minecraft-3' : process.argv[argAt + 1]) as CollectionId
);
if (!definition?.laststicker) {
  console.error(`no collection with a laststicker set: ${process.argv[argAt + 1]}`);
  process.exit(1);
}
const { set: SET, ...setOptions } = definition.laststicker;
const SCAN_DELAY_MS = 1500;
const threshold = DEFAULT_IMAGE_MATCH_THRESHOLD;
const cacheDir = process.env.MODEL_CACHE_DIR || path.join(process.cwd(), 'models');
const fmt = (n: number): string => n.toFixed(4);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Scored = { label: string; sim: number }[];

function stats(values: number[]): { min: number; median: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { min: sorted[0]!, median, max: sorted[sorted.length - 1]! };
}

function errorsAt(trueSims: Scored, falseSims: Scored, t: number): string {
  const missed = trueSims.filter((s) => s.sim < t).length;
  const wrong = falseSims.filter((s) => s.sim >= t).length;
  return `${missed}/${trueSims.length} true pairs unconfirmed, ${wrong}/${falseSims.length} false pairs confirmed`;
}

function fewestErrors(trueSims: Scored, falseSims: Scored): number {
  let best = { threshold: 0, errors: Infinity };
  for (const { sim: t } of [...trueSims, ...falseSims]) {
    const errors =
      trueSims.filter((s) => s.sim < t).length + falseSims.filter((s) => s.sim >= t).length;
    if (errors < best.errors) best = { threshold: t, errors };
  }
  return best.threshold;
}

/** Card id → picture of the shop's single-card listings naming their card in the title. */
function picturesById(listings: readonly Listing[]): Map<CardId, string> {
  const map = new Map<CardId, string>();
  for (const l of listings) {
    if (l.cardIds.length !== 1 || l.imageUrl === null || l.idConflict) continue;
    if (l.idSource === 'picture') continue;
    if (!map.has(l.cardIds[0]!)) map.set(l.cardIds[0]!, l.imageUrl);
  }
  return map;
}

const { rows } = await fetchLaststickerSet(SET, setOptions);
const names = new Map<CardId, string>(rows.map((r) => [r.cardId, r.name]));
const puzzle = new Set(
  rows.filter((r) => r.puzzle || /^Puzzlekarte/.test(r.kind)).map((r) => r.cardId)
);
console.log(
  `${definition.id} laststicker ${SET}: ${rows.length} cards, ${puzzle.size} puzzle cards, known twins ${JSON.stringify(definition.knownTwins ?? [])}`
);

/** Each shop is read once, also when its pictures are fallback references too. */
const once = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= load());
};
const shops: { name: string; load: () => Promise<readonly Listing[]> }[] = [];
const enteSettings = definition.shops['sammel-ente'];
const collectSettings = definition.shops['collect-it'];
const empty = async (): Promise<readonly Listing[]> => [];
shops.push({
  name: 'sammel-ente',
  load: enteSettings
    ? once(async () => (await createSammelEnteFetcher(enteSettings).fetchListings()).listings)
    : empty,
});
if (collectSettings) {
  shops.push({
    name: 'collect-it',
    load: async () => (await createCollectItFetcher(collectSettings).fetchListings()).listings,
  });
}
const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET } = process.env;
if (!definition.shops.ebay) {
  console.log(`eBay skipped: not read for ${definition.id} yet`);
} else if (EBAY_CLIENT_ID && EBAY_CLIENT_SECRET) {
  shops.push({
    name: 'ebay',
    load: async () =>
      (
        await createEbayFetcher({
          clientId: EBAY_CLIENT_ID,
          clientSecret: EBAY_CLIENT_SECRET,
          cardNames: () => names,
        }).fetchListings()
      ).listings,
  });
} else {
  console.log('eBay skipped: EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not set');
}

const embedder = await createTransformersEmbedder({ model: DEFAULT_IMAGE_MODEL, cacheDir });
console.log(
  `model ${DEFAULT_IMAGE_MODEL}, threshold ${threshold}, gap ${DECISION_GAP}, twins ${TWIN_SIMILARITY}`
);

// The scans, one request per SCAN_DELAY_MS.
const scans: ReferenceVector[] = [];
const scanOf = new Map<CardId, Float32Array>();
const noScan: string[] = [];
for (const [i, row] of rows.entries()) {
  if (row.pictureUrl === null) continue;
  if (i > 0) await sleep(SCAN_DELAY_MS);
  try {
    const vector = await embedder.embed(row.pictureUrl);
    scans.push({ cardId: row.cardId, vector, puzzle: puzzle.has(row.cardId) });
    scanOf.set(row.cardId, vector);
  } catch (error) {
    noScan.push(`${row.cardId} (${message(error)})`);
  }
}
console.log(
  `scans loaded: ${scans.length}; not loaded: ${noScan.length ? noScan.join('; ') : 'none'}`
);

// The production reference set: a card without a scan has sammel-ente's picture
// (referenceFallbackShop), as catalogManager.referenceCatalog chooses it.
const fallbackCards: string[] = [];
const sammelPictures = picturesById(await shops[0]!.load());
for (const row of rows) {
  if (scanOf.has(row.cardId)) continue;
  const url = sammelPictures.get(row.cardId);
  if (url === undefined) continue;
  try {
    const vector = await embedder.embed(url);
    scans.push({ cardId: row.cardId, vector, puzzle: puzzle.has(row.cardId) });
    scanOf.set(row.cardId, vector);
    fallbackCards.push(row.cardId);
  } catch (error) {
    console.log(`  fallback ${row.cardId} not loaded: ${message(error)}`);
  }
}
console.log(`fallback references (sammel-ente pictures): ${fallbackCards.join(', ') || 'none'}`);

console.log('\n== twins (reference pairs at or above TWIN_SIMILARITY, fallbacks included)');
for (let a = 0; a < scans.length; a++) {
  for (let b = a + 1; b < scans.length; b++) {
    const sim = cosineSimilarity(scans[a]!.vector, scans[b]!.vector);
    if (sim >= TWIN_SIMILARITY)
      console.log(`  ${scans[a]!.cardId} ~ ${scans[b]!.cardId}: ${fmt(sim)}`);
  }
}

let scored = 0;
for (const shop of shops) {
  console.log(`\n== ${shop.name}`);
  let pictures: Map<CardId, string>;
  try {
    pictures = picturesById(await shop.load());
  } catch (error) {
    console.log(`fetch failed: ${message(error)}`);
    continue;
  }
  const ids = [...pictures.keys()]
    .filter((id) => scanOf.has(id))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  console.log(`single-card listings with a reference: ${ids.length}`);
  if (ids.length < 2) continue;
  const trueSims: Scored = [];
  const falseSims: Scored = [];
  const ident = { decided: 0, right: 0, wrong: [] as string[], undecidedRight: 0 };
  for (const [k, id] of ids.entries()) {
    let vector: Float32Array;
    try {
      vector = await embedder.embed(pictures.get(id)!);
    } catch (error) {
      console.log(`  skip ${id}: ${message(error)}`);
      continue;
    }
    const next = ids[(k + 1) % ids.length]!;
    trueSims.push({ label: id, sim: cosineSimilarity(vector, scanOf.get(id)!) });
    falseSims.push({ label: `${id}~${next}`, sim: cosineSimilarity(vector, scanOf.get(next)!) });
    const found = identifyPicture(vector, scans, threshold);
    if (found?.decided) {
      ident.decided++;
      if (found.cardId === id) ident.right++;
      else
        ident.wrong.push(
          `${id}→${found.cardId} ${fmt(found.similarity)}${found.twin ? ' twin' : ''}${found.puzzle ? ' puzzle' : ''}`
        );
    } else if (found?.cardId === id) {
      ident.undecidedRight++;
    }
  }
  if (trueSims.length === 0) continue;
  scored += trueSims.length;
  const t = stats(trueSims.map((s) => s.sim));
  const f = stats(falseSims.map((s) => s.sim));
  console.log(
    `true  pairs (${trueSims.length}): min ${fmt(t.min)}  median ${fmt(t.median)}  max ${fmt(t.max)}`
  );
  console.log(
    `false pairs (${falseSims.length}): min ${fmt(f.min)}  median ${fmt(f.median)}  max ${fmt(f.max)}`
  );
  const lowTrue = [...trueSims].sort((a, b) => a.sim - b.sim).slice(0, 5);
  const highFalse = [...falseSims].sort((a, b) => b.sim - a.sim).slice(0, 5);
  console.log(`lowest true:   ${lowTrue.map((s) => `${s.label}=${fmt(s.sim)}`).join(', ')}`);
  console.log(`highest false: ${highFalse.map((s) => `${s.label}=${fmt(s.sim)}`).join(', ')}`);
  console.log(`at ${threshold}: ${errorsAt(trueSims, falseSims, threshold)}`);
  const best = fewestErrors(trueSims, falseSims);
  console.log(`fewest errors at ${fmt(best)}: ${errorsAt(trueSims, falseSims, best)}`);
  console.log(
    `identification against all scans: ${ident.decided}/${trueSims.length} decided, ${ident.right} right, ${ident.wrong.length} wrong${ident.wrong.length ? ` (${ident.wrong.join(', ')})` : ''}; undecided but best right: ${ident.undecidedRight}`
  );
}

if (scored === 0) {
  console.error('\nno pair could be scored');
  process.exit(1);
}
