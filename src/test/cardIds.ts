import {
  MINECRAFT_CARD_IDS,
  normalizeCardIdIn,
  TURBO_ATTAX_CARD_IDS,
  type CardId,
} from '../bot/cards/cardId';

/**
 * A canonical card id for a test, of any collection's rule (Minecraft `LE8`, Turbo Attax
 * `MR-HAM`); throws on anything that is not already canonical under one of them.
 */
export function cid(raw: string): CardId {
  for (const rule of [MINECRAFT_CARD_IDS, TURBO_ATTAX_CARD_IDS]) {
    const id = normalizeCardIdIn(rule, raw);
    if (id !== null && id === raw) return id;
  }
  throw new Error(`not a canonical card id: "${raw}"`);
}

/** Canonical card ids for a test, in the given order. */
export function ids(...raw: string[]): CardId[] {
  return raw.map(cid);
}
