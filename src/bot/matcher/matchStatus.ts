import type { CardId } from '../cards/cardId';

/**
 * How far a listing's card numbers are backed by its picture.
 * - `reference`: sammel-ente, whose pictures are the references.
 * - `pending`: not compared yet: a new single-card listing of a shop other than sammel-ente, or
 *   one whose picture, cards or id conflict changed (several cards make it a `bundle`).
 * - `confirmed`: picture matches the reference, or the admin mapped it (`similarity` null); for
 *   an eBay listing whose title names no card, the picture decided its card (`idSource`
 *   `picture`).
 * - `unconfirmed`: compared and below the threshold, an id conflict, or no picture to compare;
 *   for a title naming no card, a picture that decided nothing (the listing keeps no cards).
 * - `mismatch`: the picture decides another card than the title names (`pictureCardId`); never
 *   sent to users, the admin gets a note.
 * - `no_reference`: the card has no reference picture yet.
 * - `model_unavailable`: no image model loaded, or the model failed on the picture.
 * - `image_unavailable`: a picture could not be loaded (host, redirect, HTTP, network, size,
 *   decode).
 * - `bundle`: several cards in one listing, not compared.
 */
export const MATCH_STATUSES = [
  'reference',
  'pending',
  'confirmed',
  'unconfirmed',
  'no_reference',
  'model_unavailable',
  'image_unavailable',
  'bundle',
  'mismatch',
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** What a comparison yields: any status but `pending`, which only a listing waiting for one has. */
export type ResolvedMatchStatus = Exclude<MatchStatus, 'pending'>;

/** A card the picture was taken for, and how alike it is. */
export interface PictureCard {
  cardId: CardId;
  similarity: number;
}

/**
 * Why a picture identification did not count (counted per run, docs/image-matching.md):
 * `undecided` (below the threshold or the gap), `puzzle`, `twin`, `incomplete` (a card of the
 * best match's kind had no loaded, usable reference), `title_fits` (another card decided, but the
 * title card's own reference reaches the threshold too).
 */
export const PICTURE_REJECTIONS = [
  'undecided',
  'puzzle',
  'twin',
  'incomplete',
  'title_fits',
] as const;
export type PictureRejection = (typeof PICTURE_REJECTIONS)[number];

interface MatchCommon {
  /** Similarity with the reference of the listing's card (the title card, or the picture's). */
  similarity: number | null;
  /** Set when the picture was compared with every reference and did not count. */
  rejected?: PictureRejection;
}

/**
 * The outcome of one comparison. `picture` is the card the picture was taken for: always on a
 * mismatch, on `confirmed` when the picture decided it (rule 1 or a title naming no card), and
 * never on any other status.
 */
export type MatchResult =
  | (MatchCommon & { status: 'mismatch'; similarity: number; picture: PictureCard })
  | (MatchCommon & { status: 'confirmed'; picture: PictureCard | null })
  | (MatchCommon & {
      status: Exclude<ResolvedMatchStatus, 'mismatch' | 'confirmed'>;
      picture: null;
    });

/** What the admin-confirmation rules read of a listing. */
interface ConfirmationState {
  manualOverride: boolean;
  matchStatus: MatchStatus;
}

/** Confirmed by the admin (`/admin map` or the Confirm button): never compared again. */
export function isAdminConfirmed(listing: ConfirmationState): boolean {
  return listing.manualOverride && listing.matchStatus === 'confirmed';
}

/**
 * May the admin confirm the listing by button? Not while it is a `mismatch` (the picture shows
 * another card) or `pending` (a comparison is due): a confirmation is never compared again, so it
 * would override the picture rule for good. An admin-mapped listing is never either.
 */
export function isConfirmable(listing: ConfirmationState): boolean {
  return (
    listing.manualOverride ||
    (listing.matchStatus !== 'mismatch' && listing.matchStatus !== 'pending')
  );
}
