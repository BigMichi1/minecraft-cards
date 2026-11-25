import { shopsOf } from '../collections/index';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { CardId } from '../cards/cardId';
import type { StoredListing } from '../database/listingManager';
import { formatPrice, kleinanzeigenSearchUrl, SHOP_NAMES, validUrl } from '../notify/messages';
import type { ShopId } from '../shops/types';
import { clipText } from '../utils/messageLimit';
import { heldBack, pictureBacked, shopCells, type CellContext, type ShopCell } from './shopCell';

/** Everything `/card` shows; gathered by the command, formatted here without I/O. */
export interface CardInput extends CellContext {
  card: CardId;
  /** The catalog name, or null. */
  name: string | null;
  /** The card's usable reference picture (never a placeholder or a shared one), or null. */
  reference: string | null;
  /** The shop `shop:` names, or null for every shop the collection lists (`shopsOf`). */
  shop: ShopId | null;
}

export interface CardReply {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

/** Discord allows five buttons per action row. */
export const MAX_BUTTONS_PER_ROW = 5;
const MAX_TITLE = 256;

const STATE_LINE = {
  sold_out: ['❌', 'sold out'],
  ended: ['❌', 'ended'],
  paused: ['⏸️', 'paused'],
  held_back: ['⚠️', 'held back (picture shows another card)'],
} as const;

function priceText(l: StoredListing): string {
  return l.price ? formatPrice(l.price) : 'in stock';
}

/**
 * `(3 offers)`, with `, from <price>` when the first offer (a backed single when there is one)
 * is cheaper than the listing shown, in the same currency, or the shown one has no price.
 */
function offersText(shown: StoredListing, offers: StoredListing[]): string {
  if (offers.length < 2) return '';
  const first = offers[0]!.price;
  const cheaper =
    first !== null &&
    (shown.price === null ||
      (first.currency === shown.price.currency && first.cents < shown.price.cents));
  return ` (${offers.length} offers${cheaper ? `, from ${formatPrice(first)}` : ''})`;
}

/** What the best listing's line adds: older than the last check, bundle, picture unconfirmed. */
function notes(cell: ShopCell & { kind: 'listed' }): string {
  const l = cell.listing;
  const parts: string[] = [];
  if (cell.stale) parts.push('older than the last check');
  if (l.cardIds.length > 1) parts.push('bundle');
  else if (!pictureBacked(l) && !heldBack(l)) parts.push('picture unconfirmed');
  return parts.map((p) => ` · ${p}`).join('');
}

function shopLine(shop: ShopId, cell: ShopCell): string {
  const name = SHOP_NAMES[shop];
  switch (cell.kind) {
    case 'not_enabled':
      return `⚪ ${name}: not enabled`;
    case 'unknown':
      return `❔ ${name}: ? (its last check failed or did not run)`;
    case 'not_listed':
      return `➖ ${name}: not listed`;
    case 'listed':
      break;
  }
  if (cell.state === 'in_stock') {
    return `✅ ${name}: ${priceText(cell.listing)}${offersText(cell.listing, cell.offers)}${notes(cell)}`;
  }
  const [icon, text] = STATE_LINE[cell.state];
  return `${icon} ${name}: ${text}${notes(cell)}`;
}

function lastCheckLine(input: CardInput): string {
  const last = input.latest.summary;
  if (last) return `Last check <t:${Math.floor(last.startedAt / 1000)}:R>`;
  return input.latest.newerUnreadable ? '⚠️ No readable check record.' : 'No check has run yet.';
}

function link(label: string, url: string): ButtonBuilder {
  return new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
}

/** The buttons in rows of at most MAX_BUTTONS_PER_ROW; no buttons, no rows. */
export function linkRows(buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_ROW) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + MAX_BUTTONS_PER_ROW))
    );
  }
  return rows;
}

/**
 * The `/card` reply: an embed titled `#12 Squid` with one line per shop the collection lists (or the `shop:` one) (the best listing, as in
 * `/missing status`, with the offer count when there are several), the last check, and the
 * reference picture as thumbnail. Each shop with an offer gets an `Open <shop>` link button to
 * its first offer with a valid URL (the cheapest backed single, else the cheapest other single,
 * else the cheapest bundle); held-back and paused listings are never offered. Without `shop:` a
 * Kleinanzeigen search button follows.
 */
export function buildCardReply(input: CardInput): CardReply {
  const cellAt = shopCells(input);
  const shops = input.shop ? [input.shop] : shopsOf(input.collection);
  const lines: string[] = [];
  const buttons: ButtonBuilder[] = [];
  for (const shop of shops) {
    const cell = cellAt(input.card, shop);
    lines.push(shopLine(shop, cell));
    if (cell.kind !== 'listed') continue;
    const url = cell.offers.map((l) => validUrl(l.url)).find((u) => u !== null);
    if (url) buttons.push(link(`Open ${SHOP_NAMES[shop]}`, url));
  }
  const search = input.shop ? null : kleinanzeigenSearchUrl(input.collection, input.card);
  if (search) buttons.push(link(`Kleinanzeigen #${input.card}`, search));
  const embed = new EmbedBuilder()
    .setTitle(clipText(input.name ? `#${input.card} ${input.name}` : `#${input.card}`, MAX_TITLE))
    .setDescription([...lines, '', lastCheckLine(input)].join('\n'));
  const thumbnail = validUrl(input.reference);
  if (thumbnail) embed.setThumbnail(thumbnail);
  return { embeds: [embed], components: linkRows(buttons) };
}
