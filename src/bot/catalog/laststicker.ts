import * as cheerio from 'cheerio';
import { normalizeCardId, type CardId } from '../cards/cardId';
import type { FetchFn } from '../shops/types';
import { fetchText } from '../utils/http';
import { clipText } from '../utils/messageLimit';

/** laststicker values in an error are clipped to this many characters. */
const MAX_VALUE = 200;

/**
 * A laststicker page that is not a readable checklist: no table (a bot wall, maintenance), a
 * row that does not parse, or a number the card id rule rejects. A sync that meets it changes
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
  cardId: CardId;
  name: string;
  kind: string;
  variant: string;
  /** The card's scan; laststicker answers 404 for a card it has not scanned. */
  pictureUrl: string;
}

/** The set page; robots.txt allows `/de/cards/<set>/` (never `/cards/<set>/checklist`). */
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
export function parseLaststickerPage(html: string): { setId: number; rows: LaststickerRow[] } {
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
    const cardId = normalizeCardId(number);
    if (!cardId)
      throw new CatalogLayoutError(`laststicker: row ${row}: no card number ${clip(number)}`);
    if (seen.has(cardId)) throw new CatalogLayoutError(`laststicker: card ${cardId} twice`);
    seen.add(cardId);
    const title = tds.eq(1);
    const link = title.find('a').first();
    const piece = title.children('div').text().trim();
    const name = [(link.length > 0 ? link : title).text().trim(), piece]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');
    if (!name) throw new CatalogLayoutError(`laststicker: row ${row}: no name`);
    rows.push({
      cardId,
      name,
      kind: tds.eq(2).text().trim(),
      variant: tds.eq(3).text().trim(),
      pictureUrl: pictureUrl(setId, cardId),
    });
  });
  if (rows.length === 0) throw new CatalogLayoutError('laststicker: no rows in the checklist');
  return { setId, rows };
}

/** Fetch and parse one set page (`fetchText`: bot User-Agent, 20 s timeout). */
export async function fetchLaststickerSet(
  set: string,
  fetchFn: FetchFn = fetch
): Promise<{ setId: number; rows: LaststickerRow[] }> {
  return parseLaststickerPage(await fetchText(laststickerSetUrl(set), fetchFn));
}
