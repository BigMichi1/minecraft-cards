/**
 * Every customId format of the one-click confirm buttons, built and read in one place:
 * `right:<listing>` (a user's Right), `admin-confirm:<listing>:<cards>:<picture fingerprint>` and
 * `admin-dismiss:<listing>` (the admin's buttons); and the catalog removal's
 * `catalog-remove:<token>` / `catalog-keep:<token>`. The router routes by the prefixes below.
 */
import { normalizeCardId, type CardId } from '../cards/cardId';
import type { ConfirmTarget } from '../database/listingManager';
import { imageFingerprint, type ImageFingerprint } from '../matcher/imageFingerprint';

export { imageFingerprint, type ImageFingerprint };

/** Discord's limit for a component's customId. */
export const MAX_CUSTOM_ID = 100;

export const RIGHT_PREFIX = 'right:';
export const CONFIRM_PREFIX = 'admin-confirm:';
export const DISMISS_PREFIX = 'admin-dismiss:';
export const REMOVE_PREFIX = 'catalog-remove:';
export const KEEP_PREFIX = 'catalog-keep:';

const FINGERPRINT = /^[0-9a-z]{1,13}$/;

/** A listing id of 1 to 15 digits, as the button ids carry it; null otherwise. */
export function parseListingId(value: string | undefined): number | null {
  return value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

/** The listing id after `prefix` when the id has exactly that one part; null otherwise. */
function decodeSingle(prefix: string, customId: string): number | null {
  if (!customId.startsWith(prefix)) return null;
  const rest = customId.slice(prefix.length);
  return rest.includes(':') ? null : parseListingId(rest);
}

export function encodeRightId(listingId: number): string {
  return `${RIGHT_PREFIX}${listingId}`;
}

export function decodeRightId(customId: string): number | null {
  return decodeSingle(RIGHT_PREFIX, customId);
}

export function encodeDismissId(listingId: number): string {
  return `${DISMISS_PREFIX}${listingId}`;
}

export function decodeDismissId(customId: string): number | null {
  return decodeSingle(DISMISS_PREFIX, customId);
}

/** What a Confirm button names: the listing, its cards and its picture as the admin saw them. */
export type ConfirmId = ConfirmTarget;

/** The Confirm id of `listing`; null when it has no cards or the id would pass 100 characters. */
export function encodeConfirmId(listing: {
  id: number;
  cardIds: readonly CardId[];
  imageUrl: string | null;
}): string | null {
  if (listing.cardIds.length === 0) return null;
  const id = `${CONFIRM_PREFIX}${listing.id}:${listing.cardIds.join(',')}:${imageFingerprint(listing.imageUrl)}`;
  return id.length <= MAX_CUSTOM_ID ? id : null;
}

export function decodeConfirmId(customId: string): ConfirmId | null {
  if (!customId.startsWith(CONFIRM_PREFIX)) return null;
  const parts = customId.slice(CONFIRM_PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  const [rawListing, rawCards, rawImage] = parts as [string, string, string];
  const listingId = parseListingId(rawListing);
  if (listingId === null || !rawCards || !FINGERPRINT.test(rawImage)) return null;
  const cardIds: CardId[] = [];
  for (const raw of rawCards.split(',')) {
    const id = normalizeCardId(raw);
    if (!id) return null;
    cardIds.push(id);
  }
  return { listingId, cardIds, image: rawImage as ImageFingerprint };
}

export function encodeRemoveId(token: string): string {
  return `${REMOVE_PREFIX}${token}`;
}

export function encodeKeepId(token: string): string {
  return `${KEEP_PREFIX}${token}`;
}

/** Remove or Keep of a pending catalog removal, with its token; null for another id. */
export function decodeRemovalId(customId: string): { remove: boolean; token: string } | null {
  if (customId.startsWith(REMOVE_PREFIX)) {
    return { remove: true, token: customId.slice(REMOVE_PREFIX.length) };
  }
  if (customId.startsWith(KEEP_PREFIX)) {
    return { remove: false, token: customId.slice(KEEP_PREFIX.length) };
  }
  return null;
}
