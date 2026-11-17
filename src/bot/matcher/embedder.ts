import { eq } from 'drizzle-orm';
import { db } from '../database/db';
import { imageEmbeddings } from '../database/schema/index';
import type { FetchFn, Listing } from '../shops/types';
import { errorMessage } from '../utils/async';
import { HttpError, REQUEST_TIMEOUT_MS, USER_AGENT } from '../utils/http';
import logger from '../utils/logger';
import { prepareImage, type ResizeSpec } from './imageInput';
import { cosineSimilarity } from './similarity';

/**
 * Chosen with scripts/measure-threshold.ts (docs/image-matching.md): DINOv2-small separates
 * same-card from neighbouring-card pairs better than CLIP ViT-B/32.
 */
export const DEFAULT_IMAGE_MODEL = 'Xenova/dinov2-small';
/**
 * The measured groups overlap, so this is the fewest-errors point (0.7772, rounded), not a
 * gap midpoint: about 2% of same-card pairs stay unconfirmed, about 3% of neighbours confirm.
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
    const px = await prepareImage(imageBytes, spec);
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

/**
 * Local image embedder over `@huggingface/transformers` (`image-feature-extraction`).
 * Model files are downloaded once into `cacheDir`. Rejects when the model cannot load.
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
      const response = await fetchFn(imageUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new HttpError(response.status, imageUrl);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return firstVectorNormalised(await extractor(bytes));
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

export type MatchStatus =
  'reference' | 'confirmed' | 'unconfirmed' | 'no_reference' | 'model_unavailable' | 'bundle';

/**
 * Check a listing's picture against the card's reference picture.
 * sammel-ente is the reference shop; listings of several cards are bundles and not compared.
 * A missing or failing model yields `model_unavailable` (logged), never an exception.
 */
export async function matchListing(
  listing: Listing,
  reference: string | null,
  embedder: ImageEmbedder | null,
  threshold: number
): Promise<{ status: MatchStatus; similarity: number | null }> {
  if (listing.shop === 'sammel-ente') return { status: 'reference', similarity: null };
  if (listing.cardIds.length > 1) return { status: 'bundle', similarity: null };
  if (reference === null) return { status: 'no_reference', similarity: null };
  if (embedder === null) {
    logger.warn(`image match skipped for ${listing.url}: no image model loaded`);
    return { status: 'model_unavailable', similarity: null };
  }
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
    logger.warn(
      `image match failed for ${listing.url} (${embedder.model}): ${errorMessage(error)}`
    );
    return { status: 'model_unavailable', similarity: null };
  }
}
