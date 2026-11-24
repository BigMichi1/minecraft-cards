/** A listing picture URL's fingerprint, carried in the admin's Confirm button. */

declare const imageFingerprintBrand: unique symbol;
/** A picture URL's fingerprint, as `imageFingerprint` computes it or a decoded customId holds. */
export type ImageFingerprint = string & { readonly [imageFingerprintBrand]: true };

/**
 * A short fingerprint of a listing's picture URL (base 36, at most 13 characters), small enough
 * for a customId, so Confirm can tell that the picture URL changed after the DM. It covers the URL
 * only, not the picture's content, and `null` and `''` give the same value. It is stable within
 * one Bun version; `Bun.hash` may change with a Bun upgrade, which makes buttons sent before it
 * refuse as changed (safe: the admin looks again).
 */
export function imageFingerprint(imageUrl: string | null): ImageFingerprint {
  return BigInt.asUintN(64, BigInt(Bun.hash(imageUrl ?? ''))).toString(36) as ImageFingerprint;
}
