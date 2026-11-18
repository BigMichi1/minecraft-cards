import { eq } from 'drizzle-orm';
import { db } from '../database/db';
import { imageEmbeddings } from '../database/schema/index';
import type { FetchFn, Listing } from '../shops/types';
import { errorMessage } from '../utils/async';
import { HttpError, REQUEST_TIMEOUT_MS, USER_AGENT } from '../utils/http';
import logger from '../utils/logger';
import { prepareImage, type ResizeSpec } from './imageInput';
import type { CardId } from '../cards/cardId';
import type { ReferenceCatalog } from '../database/catalogManager';
import {
  atLeast,
  identifyPicture,
  isComplete,
  isTransient,
  type MissingReference,
  type PictureIdentification,
  type ReferenceSet,
  type ReferenceVector,
} from './identify';
import type { MatchResult, PictureCard, PictureRejection } from './matchStatus';
import { cosineSimilarity } from './similarity';

export type { MatchResult, MatchStatus, PictureCard } from './matchStatus';

/** A picture could not be loaded: host not allowed, network or HTTP error, too large, undecodable. */
export class ImageUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImageUnavailableError';
  }
}

/** The image model failed on a picture it was given. */
export class ModelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelError';
  }
}

/**
 * Chosen with scripts/measure-threshold.ts (docs/image-matching.md): DINOv2-small separates
 * same-card from neighbouring-card pairs better than CLIP ViT-B/32.
 */
export const DEFAULT_IMAGE_MODEL = 'Xenova/dinov2-small';
/**
 * The measured groups overlap, so this is the fewest-errors point (0.7772, rounded), not a
 * gap midpoint. At 0.7772 about 2% of same-card pairs stayed unconfirmed and about 3% of
 * neighbours confirmed; 0.78 itself was not re-measured (docs/image-matching.md).
 */
export const DEFAULT_IMAGE_MATCH_THRESHOLD = 0.78;

export interface ImageEmbedder {
  model: string;
  embed(imageUrl: string): Promise<Float32Array>;
}

/** The part of a transformers.js `Tensor` the embedder reads. */
interface FeatureTensor {
  data: ArrayLike<number>;
  dims: number[];
}

/** Encoded picture bytes in, model output out. */
type Extractor = (imageBytes: Uint8Array) => Promise<FeatureTensor>;

/** Test seams for createTransformersEmbedder; the defaults load the real model. */
export interface TransformersDeps {
  fetchFn?: FetchFn;
  loadPipeline?: (model: string, cacheDir: string) => Promise<Extractor>;
}

async function loadTransformersPipeline(model: string, cacheDir: string): Promise<Extractor> {
  const { env, pipeline, RawImage } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;
  const extractor = await pipeline('image-feature-extraction', model);
  // Resize and crop here (sharp hangs under Bun, see imageInput.ts); the processor
  // still converts to RGB, rescales and normalises.
  const processor = extractor.processor as unknown as {
    image_processor?: ResizeSpec;
  } & ResizeSpec;
  const imageProcessor = processor.image_processor ?? processor;
  const spec: ResizeSpec = { ...imageProcessor };
  imageProcessor.do_resize = false;
  imageProcessor.do_center_crop = false;

  const run = extractor as unknown as {
    processor: (image: unknown) => Promise<{ pixel_values: unknown }>;
    model: (inputs: { pixel_values: unknown }) => Promise<Record<string, FeatureTensor>>;
  };
  return async (imageBytes) => {
    let px: Awaited<ReturnType<typeof prepareImage>>;
    try {
      px = await prepareImage(imageBytes, spec);
    } catch (error) {
      throw new ImageUnavailableError(`picture could not be decoded: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    const { pixel_values } = await run.processor(
      new RawImage(px.data, px.width, px.height, px.channels)
    );
    return pooledOutput(await run.model({ pixel_values }));
  };
}

/**
 * The image-level vector of a model's outputs. The pipeline's own `pool` option only knows
 * `pooler_output`, which neither candidate's ONNX export has: CLIP returns `image_embeds`
 * (the projected pooled vector), DINOv2 only `last_hidden_state`, whose CLS token is what
 * DINOv2's pooler returns.
 */
export function pooledOutput(outputs: Record<string, FeatureTensor>): FeatureTensor {
  const tensor = outputs.pooler_output ?? outputs.image_embeds ?? outputs.last_hidden_state;
  if (!tensor) {
    throw new Error(`image model returned no usable output (${Object.keys(outputs).join(', ')})`);
  }
  return tensor;
}

/** First vector of the output (the pooled vector, or the CLS token of hidden states), L2-normalised. */
function firstVectorNormalised(tensor: FeatureTensor): Float32Array {
  const width = tensor.dims[tensor.dims.length - 1] ?? tensor.data.length;
  const vec = Float32Array.from(Array.prototype.slice.call(tensor.data, 0, width) as number[]);
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}

/** Shop pictures are well under 2 MB; anything over 10 MB is refused. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Read the body, refusing a declared or streamed size over `maxBytes`. */
async function readCapped(response: Response, url: string, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('Content-Length'));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new ImageUnavailableError(`image ${url} is ${declared} bytes, over ${maxBytes}`);
  }
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ImageUnavailableError(`image ${url} is over ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** The shops' and eBay's picture hosts; listing pictures come from scraped pages and the API. */
export const IMAGE_HOSTS: ReadonlySet<string> = new Set([
  'shop-sammel-ente.de',
  'cdn.blue-ocean.de',
  'www.blue-ocean.de',
  'www.collect-it.de',
  'i.ebayimg.com',
]);
const MAX_REDIRECTS = 3;

/** True for an https URL on one of IMAGE_HOSTS, default port, no credentials. */
export function allowedImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      IMAGE_HOSTS.has(u.hostname) &&
      u.port === '' &&
      u.username === '' &&
      u.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * GET a picture URL only on an allowed host. Redirects are followed by hand (at most
 * MAX_REDIRECTS), each target checked the same way, so a scraped URL cannot reach anything else.
 * Every failure is an ImageUnavailableError.
 */
async function fetchImage(fetchFn: FetchFn, imageUrl: string): Promise<Response> {
  let url = imageUrl;
  for (let hop = 0; ; hop++) {
    if (!allowedImageUrl(url)) throw new ImageUnavailableError(`image host not allowed: ${url}`);
    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'manual',
      });
    } catch (error) {
      throw new ImageUnavailableError(`image ${url}: ${errorMessage(error)}`, { cause: error });
    }
    const location = response.headers.get('Location');
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    await response.body?.cancel();
    if (hop >= MAX_REDIRECTS) {
      throw new ImageUnavailableError(`image ${imageUrl}: more than ${MAX_REDIRECTS} redirects`);
    }
    try {
      url = new URL(location, url).toString();
    } catch {
      throw new ImageUnavailableError(`image ${imageUrl}: bad redirect location`);
    }
  }
}

/**
 * Download a picture on an allowed host (IMAGE_HOSTS, redirects checked), with the bot
 * User-Agent, the request timeout and a size cap (MAX_IMAGE_BYTES unless a smaller `maxBytes`
 * is given). Used for image matching and for attaching pictures to notifications. Every
 * failure is an ImageUnavailableError.
 */
export async function downloadImage(
  imageUrl: string,
  fetchFn: FetchFn = fetch,
  maxBytes: number = MAX_IMAGE_BYTES
): Promise<Uint8Array> {
  const response = await fetchImage(fetchFn, imageUrl);
  if (!response.ok) {
    await response.body?.cancel();
    const error = new HttpError(response.status, imageUrl);
    throw new ImageUnavailableError(error.message, { cause: error });
  }
  try {
    return await readCapped(response, imageUrl, maxBytes);
  } catch (error) {
    if (error instanceof ImageUnavailableError) throw error;
    throw new ImageUnavailableError(`image ${imageUrl}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

/**
 * Local image embedder over `@huggingface/transformers` (`image-feature-extraction`).
 * Model files are downloaded once into `cacheDir`. Rejects when the model cannot load.
 * `embed` rejects with ImageUnavailableError when the picture cannot be loaded (host outside
 * IMAGE_HOSTS, network, HTTP status, size, decoding) and with ModelError when the model fails.
 */
export async function createTransformersEmbedder(
  opts: { model: string; cacheDir: string },
  deps: TransformersDeps = {}
): Promise<ImageEmbedder> {
  const fetchFn = deps.fetchFn ?? fetch;
  const extractor = await (deps.loadPipeline ?? loadTransformersPipeline)(
    opts.model,
    opts.cacheDir
  );

  return {
    model: opts.model,
    async embed(imageUrl: string): Promise<Float32Array> {
      const bytes = await downloadImage(imageUrl, fetchFn);
      let tensor: FeatureTensor;
      try {
        tensor = await extractor(bytes);
      } catch (error) {
        if (error instanceof ImageUnavailableError) throw error;
        throw new ModelError(`${opts.model}: ${errorMessage(error)}`, { cause: error });
      }
      return firstVectorNormalised(tensor);
    },
  };
}

function toFloat32(buffer: Buffer): Float32Array {
  // Copy: a Buffer view may not start on a 4-byte boundary.
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(bytes);
}

/** Caches `inner` embeddings in `image_embeddings` by url; a row of another model is re-embedded. */
export function createCachedEmbedder(inner: ImageEmbedder): ImageEmbedder {
  return {
    model: inner.model,
    async embed(imageUrl: string): Promise<Float32Array> {
      const row = db
        .select()
        .from(imageEmbeddings)
        .where(eq(imageEmbeddings.imageUrl, imageUrl))
        .get();
      if (row && row.model === inner.model) return toFloat32(row.embedding);

      const vec = await inner.embed(imageUrl);
      const values = {
        model: inner.model,
        embedding: Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
        createdAt: Date.now(),
      };
      db.insert(imageEmbeddings)
        .values({ imageUrl, ...values })
        .onConflictDoUpdate({ target: imageEmbeddings.imageUrl, set: values })
        .run();
      return vec;
    },
  };
}

export interface MatchOptions {
  /**
   * Called with the status and reason when the result is `model_unavailable` or
   * `image_unavailable`. Without it the reason is logged per listing; the runner collects
   * them and warns once per run instead.
   */
  onUnavailable?: (status: 'model_unavailable' | 'image_unavailable', reason: string) => void;
  /**
   * Every catalog card's embedded reference picture, and the cards left out, for the picture
   * identification (rules 1 to 5 in docs/image-matching.md). Called only once a picture has
   * been embedded; the runner loads them once per run. Without it a listing is only compared
   * with its title card's reference.
   */
  references?: () => Promise<ReferenceSet>;
}

type Unavailable = 'model_unavailable' | 'image_unavailable';

/** ImageUnavailableError and ModelError as their statuses; anything else is rethrown. */
function unavailableStatus(error: unknown): Unavailable {
  if (error instanceof ImageUnavailableError) return 'image_unavailable';
  if (error instanceof ModelError) return 'model_unavailable';
  throw error;
}

/** References embedded at once while loading a set (bounded, the model runs on the CPU). */
export const REFERENCE_CONCURRENCY = 4;

export interface LoadReferenceOptions {
  concurrency?: number;
  /** A reason not to load this picture now (it failed recently), or null to load it. */
  skip?: (url: string) => string | null;
}

/**
 * Embed every usable reference of `catalog`, at most `concurrency` at once. The catalog's gaps
 * stay `missing`; a reference that cannot be loaded joins them as `image_unavailable`, also when
 * the model fails on that one picture while it embeds others; only a model failing on every
 * reference is `model_unavailable`. Any other error (the cache's database, a bug) is rethrown.
 */
export async function loadReferenceSet(
  catalog: ReferenceCatalog,
  embedder: ImageEmbedder,
  options: LoadReferenceOptions = {}
): Promise<ReferenceSet> {
  const results: (ReferenceVector | { failed: Unavailable; detail: string } | null)[] =
    catalog.usable.map(() => null);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < catalog.usable.length; i = next++) {
      const card = catalog.usable[i]!;
      const skipped = options.skip?.(card.referenceImageUrl) ?? null;
      if (skipped !== null) {
        results[i] = { failed: 'image_unavailable', detail: skipped };
        continue;
      }
      try {
        const vector = await embedder.embed(card.referenceImageUrl);
        results[i] = { cardId: card.cardId, vector, puzzle: card.puzzle };
      } catch (error) {
        results[i] = { failed: unavailableStatus(error), detail: errorMessage(error) };
      }
    }
  };
  const workers = Math.max(
    1,
    Math.min(options.concurrency ?? REFERENCE_CONCURRENCY, catalog.usable.length)
  );
  await Promise.all(Array.from({ length: workers }, worker));
  const vectors: ReferenceVector[] = [];
  const failed: MissingReference[] = [];
  const modelWorked = results.some((r) => r !== null && 'vector' in r);
  results.forEach((r, i) => {
    if (r === null) return;
    if ('vector' in r) {
      vectors.push(r);
      return;
    }
    const reason = r.failed === 'model_unavailable' && modelWorked ? 'image_unavailable' : r.failed;
    failed.push({ cardId: catalog.usable[i]!.cardId, reason, detail: r.detail });
  });
  return { vectors, missing: [...catalog.missing, ...failed] };
}

/**
 * The picture's card when the rules let the picture decide, else why not. The title card
 * (rule 1) counts when decided; another card or a title naming none (`titleCard` null) also
 * needs the complete reference set, and never a puzzle card nor a twin.
 */
function judgePicture(
  found: PictureIdentification | null,
  titleCard: CardId | null,
  set: ReferenceSet
): { picture: PictureCard } | { rejected: PictureRejection } {
  if (found === null || !found.decided) return { rejected: 'undecided' };
  const picture = { cardId: found.cardId, similarity: found.similarity };
  if (found.cardId === titleCard) return { picture };
  if (found.puzzle) return { rejected: 'puzzle' };
  if (found.twin) return { rejected: 'twin' };
  if (!isComplete(set)) return { rejected: 'incomplete' };
  return { picture };
}

/** The status of a listing compared while references failed to load: retried, never final. */
function retryStatus(set: ReferenceSet): Unavailable | null {
  const transient = set.missing.filter(isTransient);
  if (transient.length === 0) return null;
  return transient.some((m) => m.reason === 'model_unavailable')
    ? 'model_unavailable'
    : 'image_unavailable';
}

/**
 * Check a listing's picture against the card's reference picture, and with `references` also
 * against every card's reference (docs/image-matching.md):
 * 1. the picture decides the title card: `confirmed`;
 * 2. it decides another card (not a puzzle card, no twin, every catalog card in the set) and
 *    the title card's reference stays below the threshold: `mismatch`, holding that card;
 * 3. it decides nothing: `confirmed` or `unconfirmed` by the title card's reference alone;
 * 4. an eBay title naming no card (`idSource` `picture`): the picture's decided card (same
 *    conditions as rule 2), `confirmed`, or `unconfirmed` without a card.
 * A result other than `confirmed` while references failed to load is `image_unavailable` or
 * `model_unavailable` instead, so the listing is compared again with the full set.
 * sammel-ente is the reference shop; listings of several cards are bundles and not compared.
 * No model loaded, or a ModelError, yields `model_unavailable`; a picture that cannot be
 * loaded (ImageUnavailableError: network, host, redirect, HTTP, size, decoding) yields
 * `image_unavailable`. Both are reported through `onUnavailable`. Any other error (the
 * embedding cache's database, a bug) is rethrown.
 */
export async function matchListing(
  listing: Listing,
  reference: string | null,
  embedder: ImageEmbedder | null,
  threshold: number,
  options: MatchOptions = {}
): Promise<MatchResult> {
  const unavailable = (status: Unavailable, reason: string): MatchResult => {
    if (options.onUnavailable) options.onUnavailable(status, reason);
    else logger.warn(`image match unavailable (${status}) for ${listing.url}: ${reason}`);
    return { status, similarity: null, picture: null };
  };
  const plain = (status: 'reference' | 'bundle' | 'no_reference' | 'unconfirmed'): MatchResult => ({
    status,
    similarity: null,
    picture: null,
  });
  if (listing.shop === 'sammel-ente') return plain('reference');
  if (listing.cardIds.length > 1) return plain('bundle');
  const [titleCard] = listing.cardIds;
  // A title naming no card leaves the picture alone to decide (rule 4).
  const pictureOnly = titleCard === undefined && listing.idSource === 'picture';
  if (!pictureOnly && reference === null) return plain('no_reference');
  if (embedder === null) return unavailable('model_unavailable', 'no image model loaded');
  if (listing.imageUrl === null) return plain('unconfirmed');

  let ref: Float32Array | null;
  let candidate: Float32Array;
  try {
    [ref, candidate] = await Promise.all([
      pictureOnly || reference === null ? null : embedder.embed(reference),
      embedder.embed(listing.imageUrl),
    ]);
  } catch (error) {
    return unavailable(unavailableStatus(error), errorMessage(error));
  }
  const set = options.references ? await options.references() : null;
  const judged = set
    ? judgePicture(identifyPicture(candidate, set.vectors, threshold), titleCard ?? null, set)
    : null;
  const picture = judged && 'picture' in judged ? judged.picture : null;
  let rejected = judged && 'rejected' in judged ? judged.rejected : undefined;
  const withRejection = <T extends MatchResult>(result: T): T =>
    rejected === undefined ? result : { ...result, rejected };
  const retry = set ? retryStatus(set) : null;
  const retryable = (): MatchResult =>
    withRejection({ status: retry!, similarity: null, picture: null });

  if (ref === null) {
    if (picture) return { status: 'confirmed', similarity: picture.similarity, picture };
    if (retry) return retryable();
    return withRejection({ status: 'unconfirmed', similarity: null, picture: null });
  }
  const similarity = cosineSimilarity(ref, candidate);
  const titleFits = atLeast(similarity, threshold);
  if (picture && picture.cardId !== titleCard) {
    // A picture that also reaches the title card's reference does not contradict the title:
    // some cards share their art (#59 and XXL1 Charged Creeper, 2026-11-18).
    // An accepted other card implies a complete set, so no reference failed: no retry here.
    if (titleFits) rejected = 'title_fits';
    else return { status: 'mismatch', similarity, picture };
  }
  if (picture?.cardId === titleCard && !listing.idConflict) {
    return { status: 'confirmed', similarity, picture };
  }
  if (titleFits && !listing.idConflict) {
    return withRejection({ status: 'confirmed', similarity, picture: null });
  }
  if (retry) return retryable();
  return withRejection({ status: 'unconfirmed', similarity, picture: null });
}
