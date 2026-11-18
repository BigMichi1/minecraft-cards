import { eq } from 'drizzle-orm';
import { db } from '../database/db';
import { imageEmbeddings } from '../database/schema/index';
import type { FetchFn, Listing } from '../shops/types';
import { errorMessage } from '../utils/async';
import { HttpError, REQUEST_TIMEOUT_MS, USER_AGENT } from '../utils/http';
import logger from '../utils/logger';
import { prepareImage, type ResizeSpec } from './imageInput';
import type { CardId } from '../cards/cardId';
import type { ReferenceCard } from '../database/catalogManager';
import { identifyPicture, type PictureIdentification, type ReferenceVector } from './identify';
import type { ResolvedMatchStatus } from './matchStatus';
import { cosineSimilarity } from './similarity';

export type { MatchStatus } from './matchStatus';

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
   * Every card's embedded reference picture, for the picture identification (rules 1 to 5 in
   * docs/image-matching.md). Called only once a picture has been embedded; the runner loads
   * them once per run. Without it a listing is only compared with its title card's reference.
   */
  references?: () => Promise<readonly ReferenceVector[]>;
}

/** The picture's card as the rules accepted it: the title card, another card, or a new one. */
export interface PictureCard {
  cardId: CardId;
  similarity: number;
}

export interface MatchResult {
  status: ResolvedMatchStatus;
  /** Similarity with the reference of the listing's card (the title card, or the picture's). */
  similarity: number | null;
  /** Set when the picture decided a card (rules 1, 2 and 4); null otherwise. */
  picture: PictureCard | null;
}

const unmatched = (status: ResolvedMatchStatus): MatchResult => ({
  status,
  similarity: null,
  picture: null,
});

/** ImageUnavailableError and ModelError as their statuses; anything else is rethrown. */
function unavailableStatus(error: unknown): 'image_unavailable' | 'model_unavailable' {
  if (error instanceof ImageUnavailableError) return 'image_unavailable';
  if (error instanceof ModelError) return 'model_unavailable';
  throw error;
}

/**
 * Embed every card's reference picture. A reference that cannot be loaded or embedded is
 * skipped and reported through `onSkipped`; any other error (the cache's database, a bug) is
 * rethrown.
 */
export async function loadReferenceVectors(
  cards: readonly ReferenceCard[],
  embedder: ImageEmbedder,
  onSkipped: (status: 'model_unavailable' | 'image_unavailable', reason: string) => void
): Promise<ReferenceVector[]> {
  const vectors: ReferenceVector[] = [];
  for (const card of cards) {
    try {
      vectors.push({
        cardId: card.cardId,
        vector: await embedder.embed(card.referenceImageUrl),
        puzzle: card.puzzle,
      });
    } catch (error) {
      onSkipped(unavailableStatus(error), errorMessage(error));
    }
  }
  return vectors;
}

/**
 * The picture's card, when the rules let the picture decide: a decided best match, and for
 * another card than the title's (`titleCard` null for a title naming none) never a puzzle card
 * (rule 5) nor a card whose reference has a twin (same art on another card).
 */
function acceptedPicture(
  found: PictureIdentification | null,
  titleCard: CardId | null
): PictureCard | null {
  if (found === null || !found.decided) return null;
  if (found.cardId !== titleCard && (found.puzzle || found.twin)) return null;
  return { cardId: found.cardId, similarity: found.similarity };
}

/**
 * Check a listing's picture against the card's reference picture, and with `references` also
 * against every card's reference (docs/image-matching.md):
 * 1. the picture decides the title card: `confirmed`;
 * 2. it decides another card (not a puzzle card, no twin) and the title card's reference stays
 *    below the threshold: `mismatch`, holding that card;
 * 3. it decides nothing: `confirmed` or `unconfirmed` by the title card's reference alone;
 * 4. an eBay title naming no card (`idSource` `picture`): the picture's decided card (not a
 *    puzzle card, no twin), `confirmed`, or `unconfirmed` without a card.
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
  const unavailable = (status: 'model_unavailable' | 'image_unavailable', reason: string) => {
    if (options.onUnavailable) options.onUnavailable(status, reason);
    else logger.warn(`image match unavailable (${status}) for ${listing.url}: ${reason}`);
    return unmatched(status);
  };
  if (listing.shop === 'sammel-ente') return unmatched('reference');
  if (listing.cardIds.length > 1) return unmatched('bundle');
  const [titleCard] = listing.cardIds;
  // A title naming no card leaves the picture alone to decide (rule 4).
  const pictureOnly = titleCard === undefined && listing.idSource === 'picture';
  if (!pictureOnly && reference === null) return unmatched('no_reference');
  if (embedder === null) return unavailable('model_unavailable', 'no image model loaded');
  if (listing.imageUrl === null) return unmatched('unconfirmed');

  try {
    const [ref, candidate] = await Promise.all([
      pictureOnly || reference === null ? null : embedder.embed(reference),
      embedder.embed(listing.imageUrl),
    ]);
    const found = options.references
      ? identifyPicture(candidate, await options.references(), threshold)
      : null;
    const picture = acceptedPicture(found, titleCard ?? null);
    if (ref === null) {
      return picture
        ? { status: 'confirmed', similarity: picture.similarity, picture }
        : unmatched('unconfirmed');
    }
    const similarity = cosineSimilarity(ref, candidate);
    // A picture that also reaches the title card's reference does not contradict the title:
    // some cards share their art (#59 and XXL1 Charged Creeper, 2026-11-18).
    if (picture && picture.cardId !== titleCard && similarity < threshold) {
      return { status: 'mismatch', similarity, picture };
    }
    if (picture?.cardId === titleCard && !listing.idConflict) {
      return { status: 'confirmed', similarity, picture };
    }
    const confirmed = similarity >= threshold && !listing.idConflict;
    return { status: confirmed ? 'confirmed' : 'unconfirmed', similarity, picture: null };
  } catch (error) {
    return unavailable(unavailableStatus(error), errorMessage(error));
  }
}
