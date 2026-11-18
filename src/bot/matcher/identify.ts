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
 * (Charged Creeper) 0.945, LE10 and LE11 (the same placeholder picture) 1.0; the next most
 * alike pair 0.866 (LE5 and LE13).
 */
export const TWIN_SIMILARITY = 0.9;

/** One card's reference picture, embedded. */
export interface ReferenceVector {
  cardId: CardId;
  vector: Float32Array;
  /** A puzzle card (`cards.puzzle`): pieces of one big picture, alike, see rule 5. */
  puzzle: boolean;
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
   * `similarity >= threshold` and it leads `runnerUp` by at least DECISION_GAP. A puzzle card
   * or twin card can be decided here; whether that counts is the caller's rule (matchListing).
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
    (other) => other !== ref && cosineSimilarity(other.vector, ref.vector) >= TWIN_SIMILARITY
  );
  return {
    cardId: best.ref.cardId,
    similarity: best.similarity,
    runnerUp,
    puzzle: best.ref.puzzle,
    twin,
    decided:
      best.similarity >= threshold &&
      (runnerUp === null || best.similarity - runnerUp >= DECISION_GAP),
  };
}
