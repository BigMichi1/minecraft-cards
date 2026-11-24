import type { CardId } from '../cards/cardId';
import { cosineSimilarity } from './similarity';

/**
 * How far the best reference must lead the second-best for the picture to decide its card.
 * Measured on 2026-11-18 (docs/image-matching.md): with the match threshold and this gap, 143
 * of 164 eBay pictures were decided and none was wrong.
 */
export const DECISION_GAP = 0.02;

/**
 * Two reference pictures at least this alike show the same art: the picture cannot tell those
 * cards apart. Measured on 2026-11-18 over the 251 sammel-ente references: #59 and XXL1
 * (Charged Creeper) 0.945; the next most alike pair 0.866 (LE5 and LE13).
 */
export const TWIN_SIMILARITY = 0.9;

/**
 * Float32 embeddings put a similarity that is exactly a bar a few 1e-8 below it; every bar
 * (threshold, gap, twin) is met within this much.
 */
export const SIMILARITY_EPSILON = 1e-6;

/** `value` reaches `bar`, within SIMILARITY_EPSILON. */
export function atLeast(value: number, bar: number): boolean {
  return value >= bar - SIMILARITY_EPSILON;
}

/** One card's reference picture, embedded. */
export interface ReferenceVector {
  cardId: CardId;
  vector: Float32Array;
  /** A puzzle card: pieces of one big picture, alike, see rule 5. */
  puzzle: boolean;
}

/**
 * Why a catalog card is not in the comparison: no reference picture, a placeholder or a picture
 * shown for several cards (catalogManager.referenceCatalog), or its picture failed to load this
 * run (`image_unavailable`, `model_unavailable`; the only retryable ones).
 */
export const MISSING_REASONS = [
  'no_picture',
  'placeholder',
  'shared',
  'image_unavailable',
  'model_unavailable',
] as const;
export type MissingReason = (typeof MISSING_REASONS)[number];

export interface MissingReference {
  cardId: CardId;
  reason: MissingReason;
  detail?: string;
}

/** Every card of one collection's catalog: embedded (`vectors`) or not in the comparison (`missing`). */
export interface ReferenceSet {
  vectors: ReferenceVector[];
  missing: MissingReference[];
}

/** A missing reference that a later run may load: the picture or the model failed this time. */
export function isTransient(m: MissingReference): boolean {
  return m.reason === 'image_unavailable' || m.reason === 'model_unavailable';
}

/**
 * Whether the picture may decide a card other than the title's against `set`: every card of the
 * collection's catalog is in the comparison. A missing card could be the true one, and the gap to the runner-up
 * would then look fine for a wrong card. Narrower scopes do not hold: on 2026-11-18, 39 of 475
 * live listing pictures reached the threshold against a reference of another kind (base, LE,
 * XXL) than their own, and 5 matched one best (docs/image-matching.md).
 */
export function isComplete(set: ReferenceSet): boolean {
  return set.missing.length === 0;
}

/** The reference a picture is most like, and whether that is decided. */
export interface PictureIdentification {
  cardId: CardId;
  similarity: number;
  /** The second-best similarity; null with a single reference. */
  runnerUp: number | null;
  puzzle: boolean;
  /** Another card's reference is at least TWIN_SIMILARITY alike the best card's (same art). */
  twin: boolean;
  /**
   * The best similarity reaches the threshold and leads `runnerUp` by DECISION_GAP (both within
   * SIMILARITY_EPSILON). A puzzle or twin card can be decided here, and so can a set with gaps;
   * whether that counts is the caller's rule (matchListing).
   */
  decided: boolean;
}

/** Compare a picture with every reference; null when there is none. */
export function identifyPicture(
  vector: Float32Array,
  references: readonly ReferenceVector[],
  threshold: number
): PictureIdentification | null {
  let best: { ref: ReferenceVector; similarity: number } | null = null;
  let runnerUp: number | null = null;
  for (const ref of references) {
    const similarity = cosineSimilarity(vector, ref.vector);
    if (best === null || similarity > best.similarity) {
      if (best !== null) runnerUp = best.similarity;
      best = { ref, similarity };
    } else if (runnerUp === null || similarity > runnerUp) {
      runnerUp = similarity;
    }
  }
  if (best === null) return null;
  const { ref } = best;
  const twin = references.some(
    (other) => other !== ref && atLeast(cosineSimilarity(other.vector, ref.vector), TWIN_SIMILARITY)
  );
  return {
    cardId: ref.cardId,
    similarity: best.similarity,
    runnerUp,
    puzzle: ref.puzzle,
    twin,
    decided:
      atLeast(best.similarity, threshold) &&
      (runnerUp === null || atLeast(best.similarity - runnerUp, DECISION_GAP)),
  };
}
