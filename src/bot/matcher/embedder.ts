import { eq } from 'drizzle-orm';
import { db } from '../database/db';
import { imageEmbeddings } from '../database/schema/index';
import type { FetchFn, Listing } from '../shops/types';
import { errorMessage } from '../utils/async';
import { HttpError, REQUEST_TIMEOUT_MS, USER_AGENT } from '../utils/http';
import logger from '../utils/logger';
import { prepareImage, type ResizeSpec } from './imageInput';
import type { MatchStatus, ResolvedMatchStatus } from './matchStatus';
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

/** Read the body, refusing a declared or streamed size over MAX_IMAGE_BYTES. */
async function readCapped(response: Response, url: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('Content-Length'));
  if (declared > MAX_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new ImageUnavailableError(`image ${url} is ${declared} bytes, over ${MAX_IMAGE_BYTES}`);
  }
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new ImageUnavailableError(`image ${url} is over ${MAX_IMAGE_BYTES} bytes`);
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
      const response = await fetchImage(fetchFn, imageUrl);
      if (!response.ok) {
        await response.body?.cancel();
        const error = new HttpError(response.status, imageUrl);
        throw new ImageUnavailableError(error.message, { cause: error });
      }
      let bytes: Uint8Array;
      try {
        bytes = await readCapped(response, imageUrl);
      } catch (error) {
        if (error instanceof ImageUnavailableError) throw error;
        throw new ImageUnavailableError(`image ${imageUrl}: ${errorMessage(error)}`, {
          cause: error,
        });
      }
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
}

/**
 * Check a listing's picture against the card's reference picture.
 * sammel-ente is the reference shop; listings of several cards are bundles and not compared.
 * No model loaded, or a ModelError, yields `model_unavailable`; a picture that cannot be
 * loaded (ImageUnavailableError: host, redirect, HTTP, size, decoding) yields
 * `image_unavailable`. Both are reported through `onUnavailable`. Any other error (the
 * embedding cache's database, a bug) is rethrown.
 */
export async function matchListing(
  listing: Listing,
  reference: string | null,
  embedder: ImageEmbedder | null,
  threshold: number,
  options: MatchOptions = {}
): Promise<{ status: ResolvedMatchStatus; similarity: number | null }> {
  const unavailable = (status: 'model_unavailable' | 'image_unavailable', reason: string) => {
    if (options.onUnavailable) options.onUnavailable(status, reason);
    else logger.warn(`image match unavailable (${status}) for ${listing.url}: ${reason}`);
    return { status, similarity: null };
  };
  if (listing.shop === 'sammel-ente') return { status: 'reference', similarity: null };
  if (listing.cardIds.length > 1) return { status: 'bundle', similarity: null };
  if (reference === null) return { status: 'no_reference', similarity: null };
  if (embedder === null) return unavailable('model_unavailable', 'no image model loaded');
  if (listing.imageUrl === null) return { status: 'unconfirmed', similarity: null };

  try {
    const [ref, candidate] = await Promise.all([
      embedder.embed(reference),
      embedder.embed(listing.imageUrl),
    ]);
    const similarity = cosineSimilarity(ref, candidate);
    const confirmed = similarity >= threshold && !listing.idConflict;
    return { status: confirmed ? 'confirmed' : 'unconfirmed', similarity };
  } catch (error) {
    if (error instanceof ImageUnavailableError) {
      return unavailable('image_unavailable', errorMessage(error));
    }
    if (error instanceof ModelError) return unavailable('model_unavailable', errorMessage(error));
    throw error;
  }
}
