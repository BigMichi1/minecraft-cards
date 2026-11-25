import * as cheerio from 'cheerio';
import {
  MINECRAFT_CARD_IDS,
  normalizeCardId,
  normalizeCardIdIn,
  type CardId,
  type CardIdRule,
} from '../cards/cardId';
import type { LaststickerSetOptions } from '../collections/ids';
import type { FetchFn } from '../shops/types';
import { fetchText } from '../utils/http';
import { clipText } from '../utils/messageLimit';

/** laststicker values in an error are clipped to this many characters. */
const MAX_VALUE = 200;

/**
 * A laststicker page that is not a complete, readable checklist: no table (a bot wall,
 * maintenance), no set id, no rows, a row that does not parse (too few cells, no name, section
 * or type), a number the card id rule rejects, or a card listed twice; also a sync that would
 * leave too many stored cards out (catalogManager.syncCollection). A sync that meets it changes
 * nothing.
 */
export class CatalogLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogLayoutError';
  }
}

/** One checklist row: laststicker's number, name, section (`kind`) and type (`variant`). */
export interface LaststickerRow {
  readonly cardId: CardId;
  readonly name: string;
  readonly kind: string;
  readonly variant: string;
  /** A puzzle card: the row carries a piece (`<div class="pz">`). */
  readonly puzzle: boolean;
  /**
   * The card's scan; laststicker answers 404 for a card it has not scanned. Null for a set
   * laststicker has no scans of (`scans: false`).
   */
  readonly pictureUrl: string | null;
}

/** How a collection's set page is read (CollectionDefinition.laststicker). */
export type LaststickerOptions = LaststickerSetOptions;

/** A parsed set page. */
export interface LaststickerSet {
  readonly setId: number;
  readonly rows: readonly LaststickerRow[];
}

/**
 * The set page. robots.txt (checked 2026-11-24) allows `/de/cards/<set>/` and disallows
 * `/cards/<set>/checklist`, so the bot never fetches the latter.
 */
export function laststickerSetUrl(set: string): string {
  return `https://www.laststicker.com/de/cards/${set}/`;
}

/** A card's scan: lowercase id, as laststicker answers 404 for `LE1.jpg`. */
function pictureUrl(setId: number, cardId: CardId): string {
  return `https://www.laststicker.com/i/cards/${setId}/${cardId.toLowerCase()}.jpg`;
}

const clip = (value: string) => JSON.stringify(clipText(value, MAX_VALUE));

/**
 * Parse a laststicker set page: the set id (`rel="tooltip<id>"`) and every row of the
 * `#checklist` table. A puzzle row's piece (the nested `div` after the name) joins the name:
 * "The Overworld" and `1` give "The Overworld 1". Any row that does not parse is a
 * CatalogLayoutError, so a partial read never reaches the catalog.
 */
export function parseLaststickerPage(
  html: string,
  normalize: (raw: string) => CardId | null = normalizeCardId,
  options: LaststickerOptions = {}
): LaststickerSet {
  const $ = cheerio.load(html);
  const table = $('#checklist');
  if (table.length === 0) throw new CatalogLayoutError('laststicker: no checklist table');
  const tooltip = /^tooltip(\d+)$/.exec($('.cards_tooltip').attr('rel') ?? '');
  if (!tooltip) throw new CatalogLayoutError('laststicker: no set id (rel="tooltip<id>")');
  const setId = Number(tooltip[1]);
  const rows: LaststickerRow[] = [];
  const seen = new Set<CardId>();
  table.find('tbody > tr').each((index, tr) => {
    const row = index + 1;
    const tds = $(tr).children('td');
    if (tds.length < 4) {
      throw new CatalogLayoutError(`laststicker: row ${row} has ${tds.length} cells`);
    }
    const number = tds.eq(0).text().trim();
    const aliases = options.numberAliases;
    const cardId = normalize(aliases && Object.hasOwn(aliases, number) ? aliases[number]! : number);
    if (!cardId)
      throw new CatalogLayoutError(`laststicker: row ${row}: no card number ${clip(number)}`);
    if (seen.has(cardId)) throw new CatalogLayoutError(`laststicker: card ${cardId} twice`);
    seen.add(cardId);
    const title = tds.eq(1);
    const link = title.find('a').first();
    const pieceBox = title.children('div');
    const piece = pieceBox.text().trim();
    const name = [(link.length > 0 ? link : title).text().trim(), piece]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');
    if (!name) throw new CatalogLayoutError(`laststicker: row ${row}: no name`);
    const kind = tds.eq(2).text().trim();
    const variant = tds.eq(3).text().trim();
    if (!kind || !variant) {
      throw new CatalogLayoutError(`laststicker: row ${row}: no section or type`);
    }
    rows.push({
      cardId,
      name,
      kind,
      variant,
      puzzle: pieceBox.find('.pz').length > 0,
      pictureUrl: options.scans === false ? null : pictureUrl(setId, cardId),
    });
  });
  if (rows.length === 0) throw new CatalogLayoutError('laststicker: no rows in the checklist');
  return { setId, rows };
}

/**
 * Fetch and parse one set page (`fetchText`: bot User-Agent, 20 s timeout), its numbers read with
 * the collection's card id rule (Minecraft's unless given).
 */
export async function fetchLaststickerSet(
  set: string,
  options: LaststickerOptions = {},
  fetchFn: FetchFn = fetch,
  rule: CardIdRule = MINECRAFT_CARD_IDS
): Promise<LaststickerSet> {
  return parseLaststickerPage(
    await fetchText(laststickerSetUrl(set), fetchFn),
    (raw) => normalizeCardIdIn(rule, raw),
    options
  );
}
