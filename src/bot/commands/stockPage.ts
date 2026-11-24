import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { CardId } from '../cards/cardId';
import { COLLECTION_IDS, LEGACY_COLLECTION, type CollectionId } from '../collections/ids';
import type { RunSummary } from '../check/runner';
import { LAST_SUCCESS_WINDOW_MS } from '../database/runManager';
import { SHOP_NAMES } from '../notify/messages';
import { SHOP_IDS, type ShopId } from '../shops/types';
import { DISCORD_MESSAGE_LIMIT } from '../utils/messageLimit';
import { needsLastSuccess, shopCells, type CellContext, type ShopCell } from './shopCell';

export const STOCK_FILTERS = ['all', 'missing', 'in-stock'] as const;
export type StockFilter = (typeof STOCK_FILTERS)[number];

/** Everything one `/stock` page shows; gathered by the command, formatted here without I/O. */
export interface StockInput extends CellContext {
  /** The collection shown; the paging buttons carry it. */
  collection: CollectionId;
  /** The cards of the filter, in display order: the catalog, or the user's missing list. */
  cards: CardId[];
  filter: StockFilter;
  /** The page asked for, from 1; a page past the end shows the last page. */
  page: number;
  /**
   * Per shop, the start of its newest successful check within LAST_SUCCESS_WINDOW_MS; null when
   * there is none. Only filled for shops that failed or did not run (`needsLastSuccess`).
   */
  lastSuccess: Partial<Record<ShopId, number | null>>;
}

export interface StockPage {
  content: string;
  /** The ◀ ▶ row; empty when everything fits on one page. */
  components: ActionRowBuilder<ButtonBuilder>[];
}

/**
 * Column headings inside the code block: two letters, so a row is about 24 characters and a
 * page holds 60-80 cards. The legend under the block spells them out.
 */
const SHORT: Record<ShopId, string> = {
  'sammel-ente': 'SE',
  'blue-ocean': 'BO',
  'collect-it': 'CI',
  ebay: 'EB',
};
/** Cell values, ASCII only so the columns line up (Discord draws ✅ about two columns wide). */
const IN_STOCK = 'x';
const NOT_AVAILABLE = '-';
const UNKNOWN = '?';
const NOT_ENABLED = 'n/a';
const LEGEND = [
  `\`${IN_STOCK}\` in stock · \`${NOT_AVAILABLE}\` not available · \`${UNKNOWN}\` not checked · \`${NOT_ENABLED}\` not enabled`,
  SHOP_IDS.map((shop) => `${SHORT[shop]} ${SHOP_NAMES[shop]}`).join(' · '),
];
const GAP = '  ';
const FENCE = '```';
const WINDOW_DAYS = LAST_SUCCESS_WINDOW_MS / (24 * 60 * 60 * 1000);
/** The custom id carries at most this many digits of the page. */
const MAX_PAGE_DIGITS = 4;

const FILTER_LABEL: Record<StockFilter, string> = {
  all: 'all cards',
  missing: 'your missing cards',
  'in-stock': 'cards in stock',
};

const EMPTY: Record<StockFilter, string> = {
  all: 'This collection has no cards.',
  missing: 'You have no missing cards on your list.',
  'in-stock': 'No card is in stock in any enabled shop right now.',
};

/** Collection ids are slugs (checked in `collections/ids.test.ts`): no regex syntax, no `:`. */
const CUSTOM_ID = new RegExp(
  `^stock:(?:(${COLLECTION_IDS.join('|')}):)?([1-9]\\d{0,${MAX_PAGE_DIGITS - 1}}):(${STOCK_FILTERS.join('|')})$`
);

/** What a paging button opens: one page of one filter of one collection. */
export interface StockButton {
  readonly collection: CollectionId;
  readonly page: number;
  readonly filter: StockFilter;
}

/**
 * The custom id of a paging button: `stock:<collection>:<page>:<filter>`. A page parseStockCustomId
 * would refuse (not a whole number from 1 to 9999) throws, rather than build a dead button.
 */
export function stockCustomId({ collection, page, filter }: StockButton): string {
  if (!Number.isInteger(page) || page < 1 || page >= 10 ** MAX_PAGE_DIGITS) {
    throw new RangeError(`/stock: page ${page} does not fit a button`);
  }
  return `stock:${collection}:${page}:${filter}`;
}

/**
 * The collection, page and filter of a paging button, or null for anything this bot did not
 * build: the custom id comes back from Discord, so it is matched exactly (a registered
 * collection, page 1-9999, a known filter). A button sent before collections
 * (`stock:<page>:<filter>`) is one of LEGACY_COLLECTION.
 */
export function parseStockCustomId(customId: string): StockButton | null {
  const match = CUSTOM_ID.exec(customId);
  if (!match) return null;
  return {
    collection: (match[1] as CollectionId | undefined) ?? LEGACY_COLLECTION,
    page: Number(match[2]),
    filter: match[3] as StockFilter,
  };
}

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function cellText(cell: ShopCell): string {
  switch (cell.kind) {
    case 'not_enabled':
      return NOT_ENABLED;
    case 'unknown':
      return UNKNOWN;
    case 'not_listed':
      return NOT_AVAILABLE;
    case 'listed':
      // Held back and paused listings are not offered to anyone, so they are not available.
      return cell.state === 'in_stock' ? IN_STOCK : NOT_AVAILABLE;
  }
}

/** One shop in the status line: `✅ sammel-ente`, `❌ blue-ocean failed, as of <t:…:R>`. */
function shopStatus(shop: ShopId, input: StockInput, last: RunSummary): string {
  const name = SHOP_NAMES[shop];
  if (!input.enabledShops.includes(shop)) return `⚪ ${name} n/a`;
  const entry = last.shops[shop];
  const state =
    entry === undefined
      ? `⚠️ ${name} not checked`
      : entry.error !== undefined
        ? `❌ ${name} failed`
        : `✅ ${name}`;
  if (!needsLastSuccess(last, shop, input.enabledShops)) return state;
  const success = input.lastSuccess[shop];
  if (success === undefined) throw new Error(`/stock: last success of ${shop} was not looked up`);
  return success === null
    ? `${state}, no success in ${WINDOW_DAYS} days`
    : `${state}, as of <t:${seconds(success)}:R>`;
}

/** The status lines under the title: last check, each shop, and what to be wary of. */
function statusLines(input: StockInput): string[] {
  const last = input.latest.summary;
  if (!last) {
    return [
      input.latest.newerUnreadable ? '⚠️ No readable check record.' : 'No check has run yet.',
    ];
  }
  const lines = [
    [
      `Last check <t:${seconds(last.startedAt)}:R>`,
      ...SHOP_IDS.map((s) => shopStatus(s, input, last)),
    ].join(' · '),
  ];
  if (input.now - last.startedAt > LAST_SUCCESS_WINDOW_MS) {
    lines.push(`⚠️ The last check is older than ${WINDOW_DAYS} days; stock may have changed.`);
  }
  if (input.latest.newerUnreadable) {
    lines.push('⚠️ The latest check record could not be read; showing the one before.');
  }
  if (last.error !== undefined) lines.push('❌ The last check failed (see /admin status).');
  return lines;
}

function pagingRow(collection: CollectionId, page: number, pages: number, filter: StockFilter) {
  // At the ends the disabled button keeps a distinct id: Discord rejects duplicate custom ids.
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(stockCustomId({ collection, page: Math.max(1, page - 1), filter }))
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 1),
    new ButtonBuilder()
      .setCustomId(stockCustomId({ collection, page: Math.min(pages, page + 1), filter }))
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === pages)
  );
}

/**
 * One `/stock` page: a title with the filter and `page x/y`, the last check per shop, a code
 * block with a row per card and a column per shop (`x`, `-`, `?`, `n/a`), and a legend. The rows
 * per page follow from the widths: what the page holds without rows, counted with the widest
 * page label, leaves room for a whole number of rows of the table's full width, so every page
 * fits in Discord's 2000 characters and one more row would not. With more than one page, ◀ ▶
 * buttons page through it.
 */
export function buildStockPage(input: StockInput): StockPage {
  const cellAt = shopCells(input);
  const rows = input.cards.map((card) => ({
    card: card as string,
    cells: SHOP_IDS.map((shop) => cellText(cellAt(card, shop))),
  }));
  const shown = input.filter === 'in-stock' ? rows.filter((r) => r.cells.includes(IN_STOCK)) : rows;
  if (shown.length === 0) return { content: EMPTY[input.filter], components: [] };

  const cardWidth = Math.max('Card'.length, ...shown.map((r) => r.card.length));
  const widths = SHOP_IDS.map((shop) => Math.max(SHORT[shop].length, NOT_ENABLED.length));
  // Every line is padded to the full width (trailing spaces included), so each row costs the
  // same and the page can be filled exactly.
  const line = (cells: string[]) =>
    cells.map((text, i) => text.padEnd(i === 0 ? cardWidth : widths[i - 1]!)).join(GAP);
  const header = line(['Card', ...SHOP_IDS.map((shop) => SHORT[shop])]);
  const rowWidth = header.length;
  const status = statusLines(input);

  const render = (label: string, body: string[]) =>
    [
      `Stock · ${FILTER_LABEL[input.filter]} (${shown.length}) · page ${label}`,
      ...status,
      FENCE,
      header,
      ...body,
      FENCE,
      ...LEGEND,
    ].join('\n');
  // The rows left after the frame, whose page label `x/y` is counted at its widest (`99/99` for
  // a two-digit page count). The page count depends on the rows per page, so its digits are
  // raised until they hold it; they only grow, so this ends.
  let digits = 1;
  let perPage: number;
  let pages: number;
  for (;;) {
    const widest = '9'.repeat(digits);
    const frame = render(`${widest}/${widest}`, []).length;
    perPage = Math.floor((DISCORD_MESSAGE_LIMIT - frame) / (rowWidth + 1));
    pages = Math.ceil(shown.length / perPage);
    if (String(pages).length <= digits) break;
    digits = String(pages).length;
  }
  const page = Math.min(input.page, pages);
  const body = shown
    .slice((page - 1) * perPage, page * perPage)
    .map((r) => line([r.card, ...r.cells]));
  return {
    content: render(`${page}/${pages}`, body),
    components: pages > 1 ? [pagingRow(input.collection, page, pages, input.filter)] : [],
  };
}
