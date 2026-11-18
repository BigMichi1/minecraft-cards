import { EmbedBuilder } from 'discord.js';
import type { CardId } from '../cards/cardId';
import type { RunSummary } from '../check/runner';
import type { StoredListing } from '../database/listingManager';
import { LAST_SUCCESS_WINDOW_MS, type LatestRun } from '../database/runManager';
import { formatPrice, SHOP_NAMES, validUrl } from '../notify/messages';
import { SHOP_IDS, type ShopId } from '../shops/types';
import { clipText, DISCORD_MESSAGE_LIMIT } from '../utils/messageLimit';

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

/** What `/missing status` replies: the message text and at most one embed with the links. */
export interface StatusReply {
  content: string;
  embeds: EmbedBuilder[];
}

/** Discord's limit for an embed description. */
export const EMBED_DESCRIPTION_LIMIT = 4096;

const EMPTY_LIST = 'You have no missing cards on your list.';
const MAX_ERROR = 100;
const WINDOW_DAYS = LAST_SUCCESS_WINDOW_MS / (24 * 60 * 60 * 1000);
/** A table row aims at this width (PC); card names are shortened to keep it. */
const ROW_WIDTH = 84;
/** The card column is never narrower than this, even with many wide shop columns. */
const MIN_CARD_WIDTH = 14;
const GAP = '  ';
const FENCE = '```';
/** The longest card label (`#id name`) a link text carries. */
const MAX_LINK_LABEL = 60;
/**
 * Cell markers, in the order they are written in a cell and in the legend. Inside the code
 * block only ASCII (plus €, – and …) keeps the columns aligned: Discord draws ⏱ and ⚠ about
 * two columns wide and most superscript digits in a proportional font. So cells carry the ASCII
 * marker and `[n]` references; the legend pairs each ASCII marker (in inline code, so `*` is not
 * italics) with its symbol.
 */
type Marker = '*' | '!' | '+';
const MARKERS: readonly { marker: Marker; legend: string }[] = [
  { marker: '*', legend: '`*` ⏱ older than the last check' },
  { marker: '!', legend: '`!` ⚠ picture unconfirmed' },
  { marker: '+', legend: '`+` bundle' },
];

/** The reference of a linked cell, the same in the cell and at the start of its link line. */
function reference(n: number): string {
  return `[${n}]`;
}

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

/**
 * The latest check of one shop. A shop whose cells may be older than the last check (its check
 * failed or did not run) also says how old: its last success within the window, or none.
 */
function shopLine(shop: ShopId, input: StatusInput, last: RunSummary): string {
  const name = SHOP_NAMES[shop];
  if (!input.enabledShops.includes(shop)) return `⚪ ${name}: not enabled`;
  const entry = last.shops[shop];
  const state =
    entry === undefined
      ? `⚠️ ${name}: not checked`
      : entry.error !== undefined
        ? `❌ ${name}: error <t:${seconds(last.startedAt)}:R> – ${entry.error.slice(0, MAX_ERROR)}`
        : `✅ ${name}: ${entry.listings} listings`;
  if (!needsLastSuccess(last, shop, input.enabledShops)) return state;
  // buildStatusReply checked that every shop needing it was looked up, so undefined cannot
  // occur here; only null (none in the window) is left.
  const success = input.lastSuccess[shop]!;
  return success === null
    ? `${state} · no successful check in ${WINDOW_DAYS} days`
    : `${state} · data as of <t:${seconds(success)}:R>`;
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

/** One table cell; `link` is set only for an in-stock cell whose listing URL is valid. */
interface Cell {
  value: string;
  markers: Set<Marker>;
  link?: { url: string; listing: StoredListing };
}

function cellFor(card: CardId, shop: ShopId, input: StatusInput): Cell {
  const markers = new Set<Marker>();
  const last = input.latest.summary;
  if (!input.enabledShops.includes(shop)) return { value: 'n/a', markers };
  // Without a readable run there is no telling what any shop lists.
  if (!last) return { value: '?', markers };
  const here = input.listings.filter((l) => l.shop === shop && l.cardIds.includes(card));
  if (here.length === 0) {
    // Without a successful check there is no telling whether the shop lists the card.
    return { value: succeeded(last, shop) ? '–' : '?', markers };
  }
  const l = best(here, last, input.now);
  if (unseen(l, last) || needsLastSuccess(last, shop, input.enabledShops)) markers.add('*');
  if (l.cardIds.length > 1) markers.add('+');
  else if (!pictureBacked(l)) markers.add('!');
  if (!l.available) return { value: 'sold out', markers };
  if (ended(l, input.now)) return { value: 'ended', markers };
  if (l.onHold) return { value: 'paused', markers };
  const value = l.price ? formatPrice(l.price) : 'in stock';
  const url = validUrl(l.url);
  return url ? { value, markers, link: { url, listing: l } } : { value, markers };
}

/** The value, then after one space its markers and its reference if linked: `0,55 € *![3]`. */
function cellText(cell: Cell, ref: number | undefined): string {
  const marks = MARKERS.filter((m) => cell.markers.has(m.marker))
    .map((m) => m.marker)
    .join('');
  const suffix = `${marks}${ref === undefined ? '' : reference(ref)}`;
  return suffix ? `${cell.value} ${suffix}` : cell.value;
}

interface Label {
  id: string;
  full: string;
}

/** `#id name`, the name on one line and without backticks that could close the code block. */
function cardLabel(card: CardId, input: StatusInput): Label {
  const name = (input.names.get(card) ?? '').replace(/`/g, "'").replace(/\s+/g, ' ').trim();
  return { id: `#${card}`, full: name ? `#${card} ${name}` : `#${card}` };
}

/** The label cut to `width` with `…`, never into the `#id`. */
function shorten(label: Label, width: number): string {
  return clipText(label.full, Math.max(width, label.id.length + 2));
}

function escapeLinkText(text: string): string {
  return text.replace(/[[\]\\]/g, '\\$&');
}

/** A URL safe inside the `(...)` of a markdown link: parentheses and whitespace percent-encoded. */
function escapeLinkUrl(url: string): string {
  // encodeURIComponent leaves parentheses as they are.
  return url.replace(/[()\s]/g, (c) =>
    c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c)
  );
}

function linkLine(ref: number, label: Label, value: string, url: string, l: StoredListing) {
  const bundle = l.cardIds.length > 1 ? ' (bundle)' : '';
  const text = `${clipText(label.full, MAX_LINK_LABEL)} · ${SHOP_NAMES[l.shop]} · ${value}${bundle}`;
  return `${reference(ref)} [${escapeLinkText(text)}](${escapeLinkUrl(url)})`;
}

interface Row {
  text: string;
  markers: Set<Marker>;
  /** The link lines of this row's numbered cells, in number order. */
  links: string[];
}

/**
 * The header row and one row per card. Each shop column is as wide as its widest cell or name;
 * the card column takes what is left of ROW_WIDTH (at least MIN_CARD_WIDTH) and longer labels
 * are shortened. Numbers run row by row, left to right, over the linked cells only.
 */
function buildTable(input: StatusInput): { header: string; rows: Row[] } {
  let ref = 0;
  const built = input.cards.map((card) => {
    const label = cardLabel(card, input);
    const links: string[] = [];
    const markers = new Set<Marker>();
    const texts = SHOP_IDS.map((shop) => {
      const cell = cellFor(card, shop, input);
      for (const m of cell.markers) markers.add(m);
      if (!cell.link) return cellText(cell, undefined);
      ref++;
      links.push(linkLine(ref, label, cell.value, cell.link.url, cell.link.listing));
      return cellText(cell, ref);
    });
    return { label, texts, markers, links };
  });
  const widths = SHOP_IDS.map((shop, i) =>
    Math.max(SHOP_NAMES[shop].length, ...built.map((b) => b.texts[i]!.length))
  );
  const shopsWidth = widths.reduce((sum, w) => sum + GAP.length + w, 0);
  const cardWidth = Math.min(
    Math.max('Card'.length, ...built.map((b) => b.label.full.length)),
    Math.max(MIN_CARD_WIDTH, ROW_WIDTH - shopsWidth)
  );
  const line = (cells: string[]) =>
    cells
      .map((text, i) => text.padEnd(i === 0 ? cardWidth : widths[i - 1]!))
      .join(GAP)
      .trimEnd();
  return {
    header: line(['Card', ...SHOP_IDS.map((shop) => SHOP_NAMES[shop])]),
    rows: built.map((b) => ({
      text: line([shorten(b.label, cardWidth), ...b.texts]),
      markers: b.markers,
      links: b.links,
    })),
  };
}

/** The markers that appear in `rows`, explained; null when none does. */
function legendLine(rows: Row[]): string | null {
  const present = MARKERS.filter((m) => rows.some((r) => r.markers.has(m.marker)));
  if (present.length === 0) return null;
  return `Legend: ${present.map((m) => m.legend).join(' · ')}`;
}

/** The message with the first `keep` rows; the legend covers only the rows shown. */
function render(head: string[], header: string, rows: Row[], keep: number): string {
  const kept = rows.slice(0, keep);
  const lines = [...head, ''];
  if (keep > 0) lines.push(FENCE, header, ...kept.map((r) => r.text), FENCE);
  if (keep < rows.length) lines.push(`… and ${rows.length - keep} more cards`);
  const legend = legendLine(kept);
  if (legend) lines.push(legend);
  return lines.join('\n');
}

/**
 * Whole link lines while they fit `limit` (an embed description); the rest counted as "… and N
 * more links". That cut is reached in practice: a line is up to about 600 characters (a URL of
 * up to 512 after `validUrl`, a label of up to MAX_LINK_LABEL), and the up to ~100 numbered cells
 * of a 2000-character table easily exceed 4096. The count alone is returned only when not even
 * the first line fits, which cannot happen at 4096 for the same reason.
 */
export function linkList(lines: string[], limit: number = EMBED_DESCRIPTION_LIMIT): string {
  const full = lines.join('\n');
  if (full.length <= limit) return full;
  for (let keep = lines.length - 1; keep > 0; keep--) {
    const cut = [...lines.slice(0, keep), `… and ${lines.length - keep} more links`].join('\n');
    if (cut.length <= limit) return cut;
  }
  return `… and ${lines.length} more links`;
}

/**
 * The `/missing status` reply: the latest check per shop, then a code-block table of the missing
 * cards (rows) by shop (columns), a legend of the markers shown, and an embed whose description
 * links every numbered in-stock cell. Whole rows are kept while the message fits Discord's 2000
 * characters, the rest counted as "… and K more cards" after the block; links of rows left out
 * are dropped, and links over 4096 characters are counted as "… and N more links". There is no
 * hard cut: the head is a few lines with every error cut to MAX_ERROR (well under the limit), so
 * at worst every row is counted.
 */
export function buildStatusReply(input: StatusInput): StatusReply {
  if (input.cards.length === 0) return { content: EMPTY_LIST, embeds: [] };
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
  const { header, rows } = buildTable(input);
  let keep = rows.length;
  let content = render(head, header, rows, keep);
  while (keep > 0 && content.length > DISCORD_MESSAGE_LIMIT) {
    keep--;
    content = render(head, header, rows, keep);
  }
  const links = rows.slice(0, keep).flatMap((r) => r.links);
  const embeds = links.length > 0 ? [new EmbedBuilder().setDescription(linkList(links))] : [];
  return { content, embeds };
}
