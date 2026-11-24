import { describe, expect, test } from 'bun:test';
import { ButtonStyle } from 'discord.js';
import type { CardId } from '../cards/cardId';
import { parseChecklist, STARTER_CHECKLIST } from '../cards/starterCatalog';
import type { RunSummary } from '../check/runner';
import { LAST_SUCCESS_WINDOW_MS } from '../database/runManager';
import type { ShopId } from '../shops/types';
import { DISCORD_MESSAGE_LIMIT } from '../utils/messageLimit';
import { cid, ids } from '../../test/cardIds';
import { runOf, storedListing as listing, T } from '../../test/listings';
import {
  buildStockPage,
  parseStockCustomId,
  STOCK_FILTERS,
  stockCustomId,
  type StockInput,
  type StockPage,
} from './stockPage';

const S = T / 1000;
const FENCE = '```';
const ALL: readonly ShopId[] = ['sammel-ente', 'blue-ocean', 'collect-it', 'ebay'];
const CATALOG: CardId[] = parseChecklist(STARTER_CHECKLIST).ids;

function input(over: Partial<StockInput> = {}): StockInput {
  return {
    collection: 'lego-minecraft-3',
    cards: ids('12', '45'),
    filter: 'all',
    page: 1,
    latest: { summary: runOf(ALL), newerUnreadable: false },
    enabledShops: ALL,
    lastSuccess: {},
    listings: [],
    now: T + 60_000,
    ...over,
  };
}

/** The lines inside the code block: the header row, then one row per card. */
function tableLines(page: StockPage): string[] {
  const lines = page.content.split('\n');
  const open = lines.indexOf(FENCE);
  const close = lines.indexOf(FENCE, open + 1);
  if (open < 0 || close < 0) return [];
  return lines.slice(open + 1, close);
}

/** card id -> its cells, in SHOP_IDS order. */
function cells(page: StockPage): Map<string, string[]> {
  return new Map(
    tableLines(page)
      .slice(1)
      .map((line) => {
        const [card, ...rest] = line.trimEnd().split(/ +/);
        return [card!, rest];
      })
  );
}

interface ButtonJson {
  custom_id: string;
  label: string;
  disabled?: boolean;
  style: number;
}
function buttons(page: StockPage): ButtonJson[] {
  return page.components.flatMap((row) => row.toJSON().components as unknown as ButtonJson[]);
}

describe('buildStockPage', () => {
  test('a page: header, last check and shops, an ASCII table and the legend', () => {
    const page = buildStockPage(
      input({
        listings: [listing('sammel-ente', ids('12')), listing('ebay', ids('12'))],
      })
    );
    expect(page.content.split('\n')).toEqual([
      'Stock · all cards (2) · page 1/1',
      `Last check <t:${S}:R> · ✅ sammel-ente · ✅ blue-ocean · ✅ collect-it · ✅ eBay`,
      FENCE,
      // Rows are padded to the full width, so every row is as long as the next.
      'Card  SE   BO   CI   EB ',
      '12    x    -    -    x  ',
      '45    -    -    -    -  ',
      FENCE,
      '`x` in stock · `-` not available · `?` not checked · `n/a` not enabled',
      'SE sammel-ente · BO blue-ocean · CI collect-it · EB eBay',
    ]);
    // One page: no paging buttons.
    expect(page.components).toEqual([]);
  });

  test('`?` for a failed or unchecked shop with nothing stored, `n/a` for one not enabled', () => {
    const page = buildStockPage(
      input({
        latest: { summary: runOf(['sammel-ente'], ['blue-ocean']), newerUnreadable: false },
        enabledShops: ['sammel-ente', 'blue-ocean', 'collect-it'],
        lastSuccess: { 'blue-ocean': T - 3_600_000, 'collect-it': null },
        listings: [listing('blue-ocean', ids('45'))],
      })
    );
    expect(cells(page).get('12')).toEqual(['-', '?', '?', 'n/a']);
    // A stored listing still shows, even though its shop's check failed.
    expect(cells(page).get('45')).toEqual(['-', 'x', '?', 'n/a']);
    expect(page.content.split('\n')[1]).toBe(
      `Last check <t:${S}:R> · ✅ sammel-ente · ❌ blue-ocean failed, as of <t:${S - 3600}:R> · ⚠️ collect-it not checked, no success in 7 days · ⚪ eBay n/a`
    );
  });

  test('without a readable run every enabled cell is `?`', () => {
    const none = buildStockPage(
      input({ latest: { summary: undefined, newerUnreadable: false }, enabledShops: ['ebay'] })
    );
    expect(none.content.split('\n')[1]).toBe('No check has run yet.');
    expect(cells(none).get('12')).toEqual(['n/a', 'n/a', 'n/a', '?']);
    const unreadable = buildStockPage(
      input({ latest: { summary: undefined, newerUnreadable: true } })
    );
    expect(unreadable.content.split('\n')[1]).toBe('⚠️ No readable check record.');
  });

  test('warnings: an old check, an unreadable newer record, a failed run', () => {
    const old: RunSummary = { ...runOf(ALL), error: 'database locked' };
    const page = buildStockPage(
      input({
        latest: { summary: old, newerUnreadable: true },
        now: T + LAST_SUCCESS_WINDOW_MS + 1,
      })
    );
    expect(page.content.split('\n').slice(2, 5)).toEqual([
      '⚠️ The last check is older than 7 days; stock may have changed.',
      '⚠️ The latest check record could not be read; showing the one before.',
      '❌ The last check failed (see /admin status).',
    ]);
  });

  test('held back, paused, sold out and ended count as not available', () => {
    const now = T + 60_000;
    const page = buildStockPage(
      input({
        cards: ids('1', '2', '3', '4'),
        listings: [
          listing('sammel-ente', ids('1'), { matchStatus: 'mismatch' }),
          listing('sammel-ente', ids('2'), { onHold: true }),
          listing('sammel-ente', ids('3'), { available: false }),
          listing('ebay', ids('4'), { format: 'auction', auctionEndsAt: now - 1 }),
        ],
        now,
      })
    );
    for (const card of ['1', '2', '3', '4']) {
      expect(cells(page).get(card)).toEqual(['-', '-', '-', '-']);
    }
  });

  test('only:in-stock keeps the cards in stock in at least one shop', () => {
    const page = buildStockPage(
      input({
        cards: ids('1', '2', '3', 'LE8'),
        filter: 'in-stock',
        listings: [
          listing('ebay', ids('1')),
          listing('sammel-ente', ids('2'), { onHold: true }),
          listing('blue-ocean', ids('LE8')),
        ],
      })
    );
    expect([...cells(page).keys()]).toEqual(['1', 'LE8']);
    expect(page.content.split('\n')[0]).toBe('Stock · cards in stock (2) · page 1/1');
  });

  test('only:missing names the list in the header', () => {
    const page = buildStockPage(input({ cards: ids('45', 'XXL1'), filter: 'missing' }));
    expect(page.content.split('\n')[0]).toBe('Stock · your missing cards (2) · page 1/1');
    expect([...cells(page).keys()]).toEqual(['45', 'XXL1']);
  });

  test('an empty result is a sentence without table or buttons', () => {
    const empty = (filter: StockInput['filter'], cards: CardId[] = []) =>
      buildStockPage(input({ cards, filter }));
    expect(empty('missing')).toEqual({
      content: 'You have no missing cards on your list.',
      components: [],
    });
    expect(empty('in-stock', ids('12')).content).toBe(
      'No card is in stock in any enabled shop right now.'
    );
    expect(empty('in-stock', ids('12')).components).toEqual([]);
    expect(empty('all').content).toBe('The catalog has no cards.');
  });

  describe('paging over the full catalog', () => {
    // The longest head: every shop failed or unchecked with an "as of", and all warnings.
    const worst = (page: number) =>
      buildStockPage(
        input({
          cards: CATALOG,
          page,
          latest: {
            summary: { ...runOf([], ['sammel-ente', 'blue-ocean', 'collect-it']), error: 'x' },
            newerUnreadable: true,
          },
          lastSuccess: {
            'sammel-ente': T - 1000,
            'blue-ocean': T - 1000,
            'collect-it': null,
            ebay: T - 1000,
          },
          now: T + LAST_SUCCESS_WINDOW_MS + 1,
        })
      );
    const pageCount = Number(/page 1\/(\d+)/.exec(worst(1).content)?.[1]);

    test('every page fits in 2000 characters, and the pages hold every card once', () => {
      expect(pageCount).toBeGreaterThan(1);
      const seen: string[] = [];
      for (let p = 1; p <= pageCount; p++) {
        const page = worst(p);
        expect(page.content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
        expect(page.content.split('\n')[0]).toBe(
          `Stock · all cards (${CATALOG.length}) · page ${p}/${pageCount}`
        );
        seen.push(...cells(page).keys());
      }
      expect(seen).toEqual(CATALOG);
    });

    test('rows per page follow from the space left: about 60-80, fewer with a longer head', () => {
      const rows = (page: StockPage) => tableLines(page).length - 1;
      const short = buildStockPage(input({ cards: CATALOG }));
      expect(rows(worst(1))).toBeGreaterThanOrEqual(55);
      expect(rows(short)).toBeLessThanOrEqual(80);
      expect(rows(short)).toBeGreaterThan(rows(worst(1)));
    });

    test('a page holds as many rows as fit: one more row would exceed 2000', () => {
      const short = buildStockPage(input({ cards: CATALOG }));
      for (const page of [worst(1), short]) {
        const [, ...rows] = tableLines(page);
        const width = rows[0]!.length;
        expect(rows.every((r) => r.length === width)).toBe(true);
        expect(page.content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
        expect(page.content.length + width + 1).toBeGreaterThan(DISCORD_MESSAGE_LIMIT);
      }
    });

    test('ten pages or more still fit: the page label widens to two digits', () => {
      const many = Array.from({ length: 800 }, (_, i) => cid(String(i + 1)));
      const at = (page: number) => buildStockPage(input({ cards: many, page }));
      const count = Number(/page 1\/(\d+)/.exec(at(1).content)?.[1]);
      expect(count).toBeGreaterThanOrEqual(10);
      const seen: string[] = [];
      for (let p = 1; p <= count; p++) {
        expect(at(p).content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
        seen.push(...cells(at(p)).keys());
      }
      expect(seen).toEqual(many);
    });

    test('first page: ◀ disabled, ▶ goes to page 2', () => {
      expect(buttons(worst(1))).toEqual([
        {
          type: 2,
          style: ButtonStyle.Secondary,
          label: '◀',
          custom_id: 'stock:lego-minecraft-3:1:all',
          disabled: true,
        },
        {
          type: 2,
          style: ButtonStyle.Secondary,
          label: '▶',
          custom_id: 'stock:lego-minecraft-3:2:all',
          disabled: false,
        },
      ] as unknown as ButtonJson[]);
    });

    test('middle page: both buttons enabled, to the pages around it', () => {
      const b = buttons(worst(2));
      expect(b.map((x) => [x.custom_id, x.disabled])).toEqual([
        ['stock:lego-minecraft-3:1:all', false],
        ['stock:lego-minecraft-3:3:all', false],
      ]);
    });

    test('last page: ▶ disabled; a page past the end shows the last page', () => {
      for (const p of [pageCount, pageCount + 5]) {
        const page = worst(p);
        expect(page.content.split('\n')[0]).toEndWith(`page ${pageCount}/${pageCount}`);
        expect(buttons(page).map((x) => [x.custom_id, x.disabled])).toEqual([
          [`stock:lego-minecraft-3:${pageCount - 1}:all`, false],
          [`stock:lego-minecraft-3:${pageCount}:all`, true],
        ]);
      }
    });

    test('the buttons keep the filter', () => {
      const page = buildStockPage(input({ cards: CATALOG, filter: 'missing' }));
      expect(buttons(page).map((x) => x.custom_id)).toEqual([
        'stock:lego-minecraft-3:1:missing',
        'stock:lego-minecraft-3:2:missing',
      ]);
    });

    test('inside the code block every character is ASCII, €, – or …', () => {
      for (let p = 1; p <= pageCount; p++) {
        for (const line of tableLines(worst(p))) {
          for (const ch of line) expect(/^[\x20-\x7e€–…]$/.test(ch)).toBe(true);
        }
      }
    });

    test('columns line up: every cell starts where its header does', () => {
      // A page that mixes x, -, ? and n/a, and the all-? worst page.
      const mixed = buildStockPage(
        input({
          cards: CATALOG,
          enabledShops: ['sammel-ente', 'blue-ocean', 'collect-it'],
          latest: {
            summary: runOf(['sammel-ente', 'blue-ocean'], ['collect-it']),
            newerUnreadable: false,
          },
          lastSuccess: { 'collect-it': null },
          listings: [
            listing('sammel-ente', ids('1', '2')),
            listing('blue-ocean', ids('2')),
            listing('collect-it', ids('3')),
          ],
        })
      );
      const values = new Set(
        tableLines(mixed)
          .slice(1)
          .flatMap((l) => l.trim().split(/ +/).slice(1))
      );
      expect([...values].sort()).toEqual(['-', '?', 'n/a', 'x']);
      for (const page of [mixed, worst(1)]) {
        const [header, ...rows] = tableLines(page);
        const starts = ['SE', 'BO', 'CI', 'EB'].map((h) => header!.indexOf(h));
        for (const line of rows) {
          expect(line.length).toBe(header!.length);
          for (const at of starts) {
            expect(line.slice(at - 2, at)).toBe('  ');
            expect(line[at]).not.toBe(' ');
          }
        }
      }
    });
  });
});

describe('stock custom ids', () => {
  test('round trip for every filter', () => {
    for (const filter of STOCK_FILTERS) {
      expect(parseStockCustomId(stockCustomId('lego-minecraft-3', 3, filter))).toEqual({
        collection: 'lego-minecraft-3',
        page: 3,
        filter,
      });
    }
  });

  test('a button sent before collections (stock:<page>:<filter>) is lego-minecraft-3', () => {
    expect(parseStockCustomId('stock:2:missing')).toEqual({
      collection: 'lego-minecraft-3',
      page: 2,
      filter: 'missing',
    });
    expect(parseStockCustomId('stock:lego-minecraft-3:2:missing')).toEqual({
      collection: 'lego-minecraft-3',
      page: 2,
      filter: 'missing',
    });
  });

  test.each([
    '',
    'stock',
    'stock:',
    'stock:1',
    'stock:0:all',
    'stock:-1:all',
    'stock:01:all',
    'stock:1.5:all',
    'stock:10000:all',
    'stock:abc:all',
    'stock:1:ALL',
    'stock:1:instock',
    'stock:1:all:x',
    'stock:lego-minecraft-9:1:all',
    'stock::1:all',
    'stock:lego-minecraft-3:0:all',
    'stock:lego-minecraft-3:1',
    'stock:1:all ',
    ' stock:1:all',
    'stockx:1:all',
    'report:1',
  ])('rejects %p', (customId) => {
    expect(parseStockCustomId(customId)).toBeNull();
  });

  test('accepts the largest page', () => {
    expect(parseStockCustomId('stock:lego-minecraft-3:9999:in-stock')).toEqual({
      collection: 'lego-minecraft-3',
      page: 9999,
      filter: 'in-stock',
    });
  });
});

describe('buildStockPage wiring checks', () => {
  test('a shop needing its last success that was not looked up is a wiring error', () => {
    expect(() =>
      buildStockPage(input({ latest: { summary: runOf(['sammel-ente']), newerUnreadable: false } }))
    ).toThrow('/stock: last success of blue-ocean was not looked up');
  });
});
