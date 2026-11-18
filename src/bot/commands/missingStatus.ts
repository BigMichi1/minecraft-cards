import type { CardId } from '../cards/cardId';
import type { RunSummary } from '../check/runner';
import type { StoredListing } from '../database/listingManager';
import { formatPrice, SHOP_NAMES } from '../notify/messages';
import { SHOP_IDS, type ShopId } from '../shops/types';
import { DISCORD_MESSAGE_LIMIT } from '../utils/messageLimit';

/** Everything `/missing status` shows; gathered by the command, formatted here without I/O. */
export interface StatusInput {
  /** The user's missing cards, in display order. */
  cards: CardId[];
  /** The latest check run; undefined before the first one. */
  last: RunSummary | undefined;
  /** Per shop, the start of its newest successful check. */
  lastSuccess: Partial<Record<ShopId, number>>;
  /** Stored listings carrying any of `cards`. */
  listings: StoredListing[];
  /** Catalog names of the cards that have one. */
  names: Map<CardId, string>;
  /** Decides whether an auction has ended since the last check. */
  now: number;
}

const EMPTY_LIST = 'You have no missing cards on your list.';
const MAX_ERROR = 100;

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** An auction whose end has passed is gone, even if the last check still saw it running. */
function ended(l: StoredListing, now: number): boolean {
  return l.auctionEndsAt !== null && l.auctionEndsAt < now;
}

/** In stock (0) beats paused after a report (1) beats sold out or ended (2). */
function rank(l: StoredListing, now: number): number {
  if (!l.available || ended(l, now)) return 2;
  return l.onHold ? 1 : 0;
}

/** The listing that best answers "can I buy this card here": in stock first, then the cheapest. */
function best(candidates: StoredListing[], now: number): StoredListing {
  return candidates.reduce((a, b) => {
    if (rank(a, now) !== rank(b, now)) return rank(a, now) < rank(b, now) ? a : b;
    return (b.price?.cents ?? Infinity) < (a.price?.cents ?? Infinity) ? b : a;
  });
}

function shopLine(shop: ShopId, last: RunSummary): string {
  const name = SHOP_NAMES[shop];
  const entry = last.shops[shop];
  if (entry === undefined) return `⚠️ ${name}: not checked`;
  if (entry.error !== undefined) {
    return `❌ ${name}: error <t:${seconds(last.startedAt)}:R> – ${entry.error.slice(0, MAX_ERROR)}`;
  }
  return `✅ ${name}: ${entry.listings} listings`;
}

function entryText(l: StoredListing, now: number): string {
  const state = !l.available
    ? 'sold out'
    : ended(l, now)
      ? 'auction ended'
      : l.onHold
        ? 'paused (reported)'
        : `${l.price ? `${formatPrice(l.price)} ` : ''}in stock`;
  return `${SHOP_NAMES[l.shop]} ${state}${l.cardIds.length > 1 ? ' (bundle)' : ''}`;
}

/**
 * For a shop whose latest check failed or did not run at all: how old its stored listings are.
 * Relative (`:R`), so data from days ago never reads as today's.
 */
function staleness(shop: ShopId, input: StatusInput): string {
  const entry = input.last?.shops[shop];
  if (entry !== undefined && entry.error === undefined) return '';
  const success = input.lastSuccess[shop];
  return success === undefined
    ? ' (never checked successfully)'
    : ` (as of <t:${seconds(success)}:R>)`;
}

function cardLine(card: CardId, input: StatusInput): string {
  const name = input.names.get(card);
  const label = `#${card}${name ? ` ${name}` : ''}`;
  if (!input.last) return `${label}: not checked yet`;
  const parts: string[] = [];
  for (const shop of SHOP_IDS) {
    const here = input.listings.filter((l) => l.shop === shop && l.cardIds.includes(card));
    if (here.length > 0) {
      parts.push(entryText(best(here, input.now), input.now) + staleness(shop, input));
    }
  }
  return `${label}: ${parts.length > 0 ? parts.join(' · ') : 'not listed in any shop'}`;
}

/**
 * The `/missing status` reply: the latest check per shop, then each missing card with what every
 * shop showed for it. Whole card lines are kept while the reply fits Discord's message limit; the
 * rest is counted as "… and K more cards".
 */
export function buildStatusReply(input: StatusInput): string {
  if (input.cards.length === 0) return EMPTY_LIST;
  const head = input.last
    ? [
        `Your missing cards (${input.cards.length}) · last check <t:${seconds(input.last.startedAt)}:R>`,
        '',
        ...SHOP_IDS.map((shop) => shopLine(shop, input.last!)),
      ]
    : [`Your missing cards (${input.cards.length})`, 'No check has run yet.'];
  const lines = input.cards.map((card) => cardLine(card, input));

  let text = [...head, '', ...lines].join('\n');
  if (text.length <= DISCORD_MESSAGE_LIMIT) return text;
  for (let keep = lines.length - 1; keep >= 0; keep--) {
    text = [...head, '', ...lines.slice(0, keep), `… and ${lines.length - keep} more cards`].join(
      '\n'
    );
    if (text.length <= DISCORD_MESSAGE_LIMIT) return text;
  }
  return text.slice(0, DISCORD_MESSAGE_LIMIT);
}
