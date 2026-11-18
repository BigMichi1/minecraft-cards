import type { CardId } from '../cards/cardId';
import type { RunSummary } from '../check/runner';
import type { StoredListing } from '../database/listingManager';
import { LAST_SUCCESS_WINDOW_MS, type LatestRun } from '../database/runManager';
import { formatPrice, SHOP_NAMES } from '../notify/messages';
import { SHOP_IDS, type ShopId } from '../shops/types';
import { DISCORD_MESSAGE_LIMIT } from '../utils/messageLimit';

/** Everything `/missing status` shows; gathered by the command, formatted here without I/O. */
export interface StatusInput {
  /** The user's missing cards, in display order. */
  cards: CardId[];
  /** The newest readable check run, and whether a newer record could not be read. */
  latest: LatestRun;
  /** The shops this process checks; any other shop shows as not enabled and has no entries. */
  enabledShops: readonly ShopId[];
  /**
   * Per shop, the start of its newest successful check within LAST_SUCCESS_WINDOW_MS; null when
   * there is none. Only filled for shops that failed or did not run (`needsLastSuccess`).
   */
  lastSuccess: Partial<Record<ShopId, number | null>>;
  /** Stored listings carrying any of `cards`. */
  listings: StoredListing[];
  /** Catalog names of the cards that have one. */
  names: Map<CardId, string>;
  /** Current time; an auction whose end is before it counts as ended. */
  now: number;
}

const EMPTY_LIST = 'You have no missing cards on your list.';
const MAX_ERROR = 100;
const WINDOW_DAYS = LAST_SUCCESS_WINDOW_MS / (24 * 60 * 60 * 1000);

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function succeeded(last: RunSummary, shop: ShopId): boolean {
  const entry = last.shops[shop];
  return entry !== undefined && entry.error === undefined;
}

/**
 * Whether `/missing status` needs `shop`'s last success: it is enabled and its latest check
 * failed or did not run. Without a readable run nothing is shown per shop, so nothing is needed.
 */
export function needsLastSuccess(
  last: RunSummary | undefined,
  shop: ShopId,
  enabledShops: readonly ShopId[]
): boolean {
  return last !== undefined && enabledShops.includes(shop) && !succeeded(last, shop);
}

/** An auction whose end has passed is gone, even if the last check still saw it running. */
function ended(l: StoredListing, now: number): boolean {
  return l.auctionEndsAt !== null && l.auctionEndsAt < now;
}

/**
 * Whether the listing's card number is backed by its picture (or the admin). Bundles are never
 * compared, so they never count as picture-backed.
 */
function pictureBacked(l: StoredListing): boolean {
  return l.matchStatus === 'reference' || l.matchStatus === 'confirmed';
}

/** A listing of a shop whose latest check succeeded, but which that check did not return. */
function unseen(l: StoredListing, last: RunSummary): boolean {
  return succeeded(last, l.shop) && l.lastSeenAt < last.startedAt;
}

/**
 * Sort key, lower is better: seen in the latest check, then in stock beats paused after a
 * report beats sold out or ended, then a backed picture (never a bundle), then the lowest price
 * (none last).
 */
function sortKey(l: StoredListing, last: RunSummary, now: number): number[] {
  const tier = !l.available || ended(l, now) ? 2 : l.onHold ? 1 : 0;
  return [
    unseen(l, last) ? 1 : 0,
    tier,
    pictureBacked(l) ? 0 : 1,
    l.price?.cents ?? Number.POSITIVE_INFINITY,
  ];
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** The listing that best answers "can I buy this card here". */
function best(candidates: StoredListing[], last: RunSummary, now: number): StoredListing {
  return candidates.reduce((a, b) =>
    compareKeys(sortKey(b, last, now), sortKey(a, last, now)) < 0 ? b : a
  );
}

function shopLine(shop: ShopId, input: StatusInput, last: RunSummary): string {
  const name = SHOP_NAMES[shop];
  if (!input.enabledShops.includes(shop)) return `⚪ ${name}: not enabled`;
  const entry = last.shops[shop];
  if (entry === undefined) return `⚠️ ${name}: not checked`;
  if (entry.error !== undefined) {
    return `❌ ${name}: error <t:${seconds(last.startedAt)}:R> – ${entry.error.slice(0, MAX_ERROR)}`;
  }
  return `✅ ${name}: ${entry.listings} listings`;
}

function entryText(l: StoredListing, last: RunSummary, now: number): string {
  const state = !l.available
    ? 'sold out'
    : ended(l, now)
      ? 'auction ended'
      : l.onHold
        ? 'paused (reported)'
        : `${l.price ? `${formatPrice(l.price)} ` : ''}in stock`;
  const picture =
    l.cardIds.length > 1 ? ' (bundle)' : pictureBacked(l) ? '' : ' (picture unconfirmed)';
  const seen = unseen(l, last) ? ' (not seen in last check)' : '';
  return `${SHOP_NAMES[l.shop]} ${state}${picture}${seen}`;
}

/**
 * For a shop whose latest check failed or did not run at all: how old the shown listing is, the
 * earlier of the shop's last success and when a check last returned the listing. Relative
 * (`:R`), so data from days ago never reads as today's.
 */
function staleness(l: StoredListing, input: StatusInput, last: RunSummary): string {
  if (!needsLastSuccess(last, l.shop, input.enabledShops)) return '';
  // buildStatusReply checked that every shop needing it was looked up, so undefined cannot
  // occur here; only null (none in the window) is left.
  const success = input.lastSuccess[l.shop]!;
  return success === null
    ? ` (no successful check in ${WINDOW_DAYS} days)`
    : ` (as of <t:${seconds(Math.min(success, l.lastSeenAt))}:R>)`;
}

function cardLine(card: CardId, input: StatusInput): string {
  const name = input.names.get(card);
  const label = `#${card}${name ? ` ${name}` : ''}`;
  const last = input.latest.summary;
  if (!last) return `${label}: ${input.latest.newerUnreadable ? 'unknown' : 'not checked yet'}`;
  const parts: string[] = [];
  for (const shop of SHOP_IDS) {
    if (!input.enabledShops.includes(shop)) continue;
    const here = input.listings.filter((l) => l.shop === shop && l.cardIds.includes(card));
    if (here.length > 0) {
      const shown = best(here, last, input.now);
      parts.push(entryText(shown, last, input.now) + staleness(shown, input, last));
    } else if (!succeeded(last, shop)) {
      // Without a successful check there is no telling whether the shop lists the card.
      const why = last.shops[shop] === undefined ? 'not checked' : 'check failed';
      parts.push(`${SHOP_NAMES[shop]} unknown (${why})`);
    }
  }
  return `${label}: ${parts.length > 0 ? parts.join(' · ') : 'not listed in any shop'}`;
}

function headLines(input: StatusInput): string[] {
  const count = `Your missing cards (${input.cards.length})`;
  const last = input.latest.summary;
  if (!last) {
    return [
      count,
      input.latest.newerUnreadable ? '⚠️ No readable check record.' : 'No check has run yet.',
    ];
  }
  const head = [`${count} · last check <t:${seconds(last.startedAt)}:R>`];
  if (input.now - last.startedAt > LAST_SUCCESS_WINDOW_MS) {
    head.push(`⚠️ The last check is older than ${WINDOW_DAYS} days; stock may have changed.`);
  }
  if (input.latest.newerUnreadable) {
    head.push('⚠️ The latest check record could not be read; showing the one before.');
  }
  if (last.error !== undefined) {
    head.push(`❌ Last check failed: ${last.error.slice(0, MAX_ERROR)}`);
  }
  return [...head, '', ...SHOP_IDS.map((shop) => shopLine(shop, input, last))];
}

/**
 * The `/missing status` reply: the latest check per shop, then each missing card with what every
 * shop showed for it. Whole card lines are kept while the reply fits Discord's message limit; the
 * rest is counted as "… and K more cards". There is no hard cut: the head is a few lines with
 * every error cut to MAX_ERROR (well under the limit), so at worst every card line is counted.
 */
export function buildStatusReply(input: StatusInput): string {
  if (input.cards.length === 0) return EMPTY_LIST;
  for (const shop of SHOP_IDS) {
    if (
      needsLastSuccess(input.latest.summary, shop, input.enabledShops) &&
      input.lastSuccess[shop] === undefined
    ) {
      // A missing lookup must not read as "no success": that is a wiring error.
      throw new Error(`/missing status: last success of ${shop} was not looked up`);
    }
  }
  const head = headLines(input);
  const lines = input.cards.map((card) => cardLine(card, input));

  const text = [...head, '', ...lines].join('\n');
  if (text.length <= DISCORD_MESSAGE_LIMIT) return text;
  for (let keep = lines.length - 1; keep > 0; keep--) {
    const cut = [...head, '', ...lines.slice(0, keep), `… and ${lines.length - keep} more cards`];
    const candidate = cut.join('\n');
    if (candidate.length <= DISCORD_MESSAGE_LIMIT) return candidate;
  }
  return [...head, '', `… and ${lines.length} more cards`].join('\n');
}
