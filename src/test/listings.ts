import type { CardId } from '../bot/cards/cardId';
import type { RunSummary } from '../bot/check/runner';
import type { CollectionId } from '../bot/collections/ids';
import type { StoredListing } from '../bot/database/listingManager';
import type { ShopId } from '../bot/shops/types';

/** A fixed test time (epoch ms) every listing and run below is relative to. */
export const T = 1_800_000_000_000;

let nextId = 1;

/**
 * A stored, in-stock, picture-backed `lego-minecraft-3` listing seen at T, priced 0,55 €; `over`
 * changes any field.
 */
export function storedListing(
  shop: ShopId,
  cards: CardId[],
  over: Partial<StoredListing> = {}
): StoredListing {
  const id = nextId++;
  return {
    id,
    collection: 'lego-minecraft-3' satisfies CollectionId,
    shop,
    url: `https://example.com/${id}`,
    title: 't',
    imageUrl: null,
    price: { cents: 55, currency: 'EUR' },
    format: 'shop',
    auctionEndsAt: null,
    available: true,
    availableSince: T,
    cardIds: cards,
    // Backed by its picture, as a sammel-ente listing was before step 2.
    matchStatus: 'confirmed',
    similarity: null,
    matchCheckedAt: null,
    idConflict: false,
    onHold: false,
    manualOverride: false,
    lastSeenAt: T,
    idSource: 'title',
    pictureCardId: null,
    rematchFrom: null,
    ...over,
  };
}

/** A run started at T in which every shop of `shops` succeeded (or failed, with `failed`). */
export function runOf(shops: readonly ShopId[], failed: readonly ShopId[] = []): RunSummary {
  const entries: RunSummary['shops'] = {};
  for (const shop of shops) entries[shop] = { listings: 1 };
  for (const shop of failed) entries[shop] = { listings: 0, error: 'HTTP 503' };
  return { startedAt: T, finishedAt: T + 1000, shops: entries, notified: 0, dmFailures: 0 };
}

export const euro = (cents: number) => ({ price: { cents, currency: 'EUR' } });
