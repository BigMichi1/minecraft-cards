/**
 * How far a listing's card numbers are backed by its picture.
 * - `reference`: sammel-ente, whose pictures are the references.
 * - `pending`: not compared yet: a new single-card listing of a shop other than sammel-ente, or
 *   one whose picture, cards or id conflict changed (several cards make it a `bundle`).
 * - `confirmed`: picture matches the reference, or the admin mapped it (`similarity` null).
 * - `unconfirmed`: compared and below the threshold, an id conflict, or no picture to compare.
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
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** What a comparison yields: any status but `pending`, which only a listing waiting for one has. */
export type ResolvedMatchStatus = Exclude<MatchStatus, 'pending'>;
