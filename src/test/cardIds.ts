import { normalizeCardId, type CardId } from '../bot/cards/cardId';

/** A canonical card id for a test; throws on anything normalizeCardId does not accept. */
export function cid(raw: string): CardId {
  const id = normalizeCardId(raw);
  if (id === null || id !== raw) throw new Error(`not a canonical card id: "${raw}"`);
  return id;
}

/** Canonical card ids for a test, in the given order. */
export function ids(...raw: string[]): CardId[] {
  return raw.map(cid);
}
