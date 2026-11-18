import { describe, expect, test } from 'bun:test';
import type { CardId } from '../cards/cardId';
import type { RunSummary } from '../check/runner';
import type { StoredListing } from '../database/listingManager';
import type { ShopId } from '../shops/types';
import { LAST_SUCCESS_WINDOW_MS } from '../database/runManager';
import { DISCORD_MESSAGE_LIMIT } from '../utils/messageLimit';
import { cid, ids } from '../../test/cardIds';
import {
  buildStatusReply,
  EMBED_DESCRIPTION_LIMIT,
  needsLastSuccess,
  superscript,
  type StatusInput,
  type StatusReply,
} from './missingStatus';

const S = 1_800_000_000; // seconds
const T = S * 1000;
const DAYS = LAST_SUCCESS_WINDOW_MS / 86_400_000;
const FENCE = '```';

let nextId = 1;
function listing(shop: ShopId, cards: CardId[], over: Partial<StoredListing> = {}): StoredListing {
  const id = nextId++;
  return {
    id,
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
    matchStatus: 'reference',
    similarity: null,
    matchCheckedAt: null,
    idConflict: false,
    onHold: false,
    manualOverride: false,
    lastSeenAt: T,
    ...over,
  };
}

const okRun: RunSummary = {
  startedAt: T,
  finishedAt: T + 1000,
  shops: { 'sammel-ente': { listings: 251 }, 'blue-ocean': { listings: 206 } },
  notified: 0,
  dmFailures: 0,
};

/** okRun with blue-ocean failed. */
const blueFailed: RunSummary = {
  ...okRun,
  shops: { ...okRun.shops, 'blue-ocean': { listings: 0, error: 'x'.repeat(150) } },
};

/** All four shops enabled and checked. */
const allRun: RunSummary = {
  ...okRun,
  shops: {
    'sammel-ente': { listings: 251 },
    'blue-ocean': { listings: 3 },
    'collect-it': { listings: 235 },
    ebay: { listings: 246 },
  },
};
const ALL: readonly ShopId[] = ['sammel-ente', 'blue-ocean', 'collect-it', 'ebay'];

function input(over: Partial<StatusInput> = {}): StatusInput {
  return {
    cards: ids('12'),
    latest: { summary: okRun, newerUnreadable: false },
    enabledShops: ['sammel-ente', 'blue-ocean'],
    lastSuccess: {},
    listings: [],
    names: new Map([[cid('12'), 'Squid']]),
    now: T + 60_000,
    ...over,
  };
}

const run = (summary: RunSummary) => ({ summary, newerUnreadable: false });
const euro = (cents: number) => ({ price: { cents, currency: 'EUR' } });

/** The lines inside the code block: the header row, then one row per card. */
function tableLines(reply: StatusReply): string[] {
  const lines = reply.content.split('\n');
  const open = lines.indexOf(FENCE);
  const close = lines.indexOf(FENCE, open + 1);
  if (open < 0 || close < 0) return [];
  return lines.slice(open + 1, close);
}

/** The cells of the row whose label starts with `label` (`#12`), the label first. */
function row(reply: StatusReply, label = '#12'): string[] | undefined {
  const line = tableLines(reply)
    .slice(1)
    .find((l) => l === label || l.startsWith(`${label} `));
  return line?.split(/ {2,}/);
}

/** The shop cells of the row of `label`, in SHOP_IDS order. */
const cells = (reply: StatusReply, label = '#12') => row(reply, label)?.slice(1);

const description = (reply: StatusReply): string | undefined =>
  reply.embeds[0]?.toJSON().description;
const links = (reply: StatusReply) => description(reply)?.split('\n') ?? [];
const legend = (reply: StatusReply) =>
  reply.content.split('\n').find((l) => l.startsWith('Legend:'));

describe('buildStatusReply', () => {
  test('a normal reply has the header, the shop lines, a table and a link per in-stock cell', () => {
    const reply = buildStatusReply(
      input({
        listings: [
          listing('sammel-ente', ids('12'), { url: 'https://shop.example/squid' }),
          listing('blue-ocean', ids('12'), { available: false }),
        ],
      })
    );
    expect(reply.content.split('\n')).toEqual([
      `Your missing cards (1) · last check <t:${S}:R>`,
      '',
      '✅ sammel-ente: 251 listings',
      '✅ blue-ocean: 206 listings',
      '⚪ collect-it: not enabled',
      '⚪ eBay: not enabled',
      '',
      FENCE,
      'Card       sammel-ente  blue-ocean  collect-it  eBay',
      '#12 Squid  0,55 €¹      sold out    n/a         n/a',
      FENCE,
    ]);
    expect(reply.embeds).toHaveLength(1);
    expect(description(reply)).toBe(
      '¹ [#12 Squid · sammel-ente · 0,55 €](https://shop.example/squid)'
    );
  });

  test('the four cards of the screenshot line up in shop columns', () => {
    const reply = buildStatusReply(
      input({
        cards: ids('14', '104', '140', '7'),
        names: new Map([
          [cid('14'), 'Alex'],
          [cid('104'), 'Ghast'],
          [cid('140'), 'Wither'],
          [cid('7'), 'Steve'],
        ]),
        latest: run(allRun),
        enabledShops: ALL,
        listings: [
          listing('sammel-ente', ids('14'), { available: false }),
          listing('collect-it', ids('14'), { ...euro(2299), url: 'https://c.example/14' }),
          listing('ebay', ids('14'), {
            ...euro(2929),
            matchStatus: 'unconfirmed',
            url: 'https://e.example/14',
          }),
          listing('sammel-ente', ids('104'), { available: false }),
          listing('blue-ocean', ids('140'), { ...euro(80), url: 'https://b.example/140' }),
          listing('sammel-ente', ids('7'), { onHold: true }),
        ],
      })
    );
    const lines = tableLines(reply);
    expect(lines).toHaveLength(5);
    const header = lines[0]!;
    expect(header.split(/ {2,}/)).toEqual([
      'Card',
      'sammel-ente',
      'blue-ocean',
      'collect-it',
      'eBay',
    ]);
    const starts = ['sammel-ente', 'blue-ocean', 'collect-it', 'eBay'].map((h) =>
      header.indexOf(h)
    );
    for (const line of lines.slice(1)) {
      for (const at of starts) {
        expect(line[at - 1]).toBe(' ');
        expect(line[at - 2]).toBe(' ');
        expect(line[at]).not.toBe(' ');
      }
      expect(line).toBe(line.trimEnd());
    }
    expect(cells(reply, '#14')).toEqual(['sold out', '–', '22,99 €¹', '29,29 € ⚠²']);
    expect(cells(reply, '#104')).toEqual(['sold out', '–', '–', '–']);
    expect(cells(reply, '#140')).toEqual(['–', '0,80 €³', '–', '–']);
    expect(cells(reply, '#7')).toEqual(['paused', '–', '–', '–']);
    expect(links(reply)).toEqual([
      '¹ [#14 Alex · collect-it · 22,99 €](https://c.example/14)',
      '² [#14 Alex · eBay · 29,29 €](https://e.example/14)',
      '³ [#140 Wither · blue-ocean · 0,80 €](https://b.example/140)',
    ]);
    expect(legend(reply)).toBe('Legend: ⚠ picture unconfirmed');
  });

  test('each cell value: price, in stock without a price, sold out, ended, paused, –, ?, n/a', () => {
    const latest = run({
      ...okRun,
      shops: { 'sammel-ente': { listings: 1 }, ebay: { listings: 1 } },
    });
    const reply = buildStatusReply(
      input({
        cards: ids('12', '45', '46'),
        names: new Map(),
        latest,
        enabledShops: ['sammel-ente', 'blue-ocean', 'ebay'],
        lastSuccess: { 'blue-ocean': null },
        listings: [
          listing('sammel-ente', ids('12'), euro(120)),
          listing('ebay', ids('12'), { format: 'auction', auctionEndsAt: T + 30_000 }),
          listing('sammel-ente', ids('45'), { price: null }),
          listing('ebay', ids('45'), { available: false }),
          listing('sammel-ente', ids('46'), { onHold: true }),
        ],
      })
    );
    expect(cells(reply, '#12')).toEqual(['1,20 €¹', '?', 'n/a', 'ended']);
    expect(cells(reply, '#45')).toEqual(['in stock²', '?', 'n/a', 'sold out']);
    expect(cells(reply, '#46')).toEqual(['paused', '?', 'n/a', '–']);
    // Only in-stock cells are linked.
    expect(links(reply).map((l) => l.split(' ')[0])).toEqual(['¹', '²']);
    expect(links(reply)[1]).toContain('[#45 · sammel-ente · in stock]');
  });

  test('a running auction is in stock; an in-stock listing beats an ended auction', () => {
    const latest = run({ ...okRun, shops: { ebay: { listings: 2 } } });
    const ended = listing('ebay', ids('12'), { format: 'auction', auctionEndsAt: T + 30_000 });
    const both = buildStatusReply(
      input({
        enabledShops: ['ebay'],
        latest,
        listings: [ended, listing('ebay', ids('12'), { format: 'fixed_price', ...euro(400) })],
      })
    );
    expect(cells(both)).toEqual(['n/a', 'n/a', 'n/a', '4,00 €¹']);
    const running = buildStatusReply(
      input({
        enabledShops: ['ebay'],
        latest,
        listings: [listing('ebay', ids('12'), { format: 'auction', auctionEndsAt: T + 120_000 })],
      })
    );
    expect(cells(running)).toEqual(['n/a', 'n/a', 'n/a', '0,55 €¹']);
  });

  test('a listing the latest successful check did not return gets ⏱ and ranks below seen ones', () => {
    const unseen = { lastSeenAt: T - 1 };
    const alone = buildStatusReply(input({ listings: [listing('blue-ocean', ids('12'), unseen)] }));
    expect(cells(alone)).toEqual(['–', '0,55 € ⏱¹', 'n/a', 'n/a']);
    expect(legend(alone)).toBe('Legend: ⏱ older than the last check');
    const both = buildStatusReply(
      input({
        listings: [
          listing('blue-ocean', ids('12'), { ...unseen, ...euro(30) }),
          listing('blue-ocean', ids('12'), euro(90)),
        ],
      })
    );
    expect(cells(both)).toEqual(['–', '0,90 €¹', 'n/a', 'n/a']);
    expect(legend(both)).toBeUndefined();
  });

  test('a failed shop shows its error and its last success on the shop line, its cells get ⏱', () => {
    const reply = buildStatusReply(
      input({
        latest: run(blueFailed),
        lastSuccess: { 'blue-ocean': T - 3_600_000 },
        listings: [listing('blue-ocean', ids('12'), { lastSeenAt: T - 86_400_000 })],
      })
    );
    expect(reply.content).toContain(
      `❌ blue-ocean: error <t:${S}:R> – ${'x'.repeat(100)} · data as of <t:${S - 3600}:R>`
    );
    expect(reply.content).not.toContain('x'.repeat(101));
    expect(cells(reply)).toEqual(['–', '0,55 € ⏱¹', 'n/a', 'n/a']);
  });

  test('a failed shop without a success in the window says so on its shop line', () => {
    const reply = buildStatusReply(
      input({
        latest: run(blueFailed),
        lastSuccess: { 'blue-ocean': null },
        listings: [listing('blue-ocean', ids('12'))],
      })
    );
    expect(reply.content).toContain(`– ${'x'.repeat(100)} · no successful check in ${DAYS} days`);
    expect(cells(reply)).toEqual(['–', '0,55 € ⏱¹', 'n/a', 'n/a']);
  });

  test('an enabled shop missing from the last check: its shop line has the last success, empty cells are ?', () => {
    const reply = buildStatusReply(
      input({
        cards: ids('12', '45'),
        enabledShops: ['sammel-ente', 'blue-ocean', 'ebay'],
        lastSuccess: { ebay: T - 86_400_000 },
        listings: [listing('ebay', ids('12'))],
      })
    );
    expect(reply.content).toContain(`⚠️ eBay: not checked · data as of <t:${S - 86_400}:R>`);
    expect(cells(reply, '#12')).toEqual(['–', '–', 'n/a', '0,55 € ⏱¹']);
    expect(cells(reply, '#45')).toEqual(['–', '–', 'n/a', '?']);
  });

  test('a shop whose last success was not looked up is a wiring error, not a guess', () => {
    expect(() => buildStatusReply(input({ latest: run(blueFailed) }))).toThrow(
      /blue-ocean.*not looked up/
    );
  });

  test('a single-card listing whose picture is not backed gets ⚠', () => {
    for (const matchStatus of [
      'pending',
      'unconfirmed',
      'no_reference',
      'model_unavailable',
      'image_unavailable',
    ] as const) {
      const reply = buildStatusReply(
        input({ listings: [listing('blue-ocean', ids('12'), { matchStatus })] })
      );
      expect(cells(reply)).toEqual(['–', '0,55 € ⚠¹', 'n/a', 'n/a']);
      expect(legend(reply)).toBe('Legend: ⚠ picture unconfirmed');
    }
    const confirmed = buildStatusReply(
      input({ listings: [listing('blue-ocean', ids('12'), { matchStatus: 'confirmed' })] })
    );
    expect(cells(confirmed)).toEqual(['–', '0,55 €¹', 'n/a', 'n/a']);
  });

  test('a bundle gets + (never ⚠) on every card it carries; its link says bundle', () => {
    const reply = buildStatusReply(
      input({
        cards: ids('12', '45'),
        listings: [listing('blue-ocean', ids('12', '45'), { matchStatus: 'bundle' })],
      })
    );
    expect(cells(reply, '#12')).toEqual(['–', '0,55 € +¹', 'n/a', 'n/a']);
    expect(cells(reply, '#45')).toEqual(['–', '0,55 € +²', 'n/a', 'n/a']);
    expect(links(reply)[0]).toMatch(/^¹ \[#12 Squid · blue-ocean · 0,55 € \(bundle\)\]\(/);
    expect(legend(reply)).toBe('Legend: + bundle');
  });

  test('markers combine, and the legend names exactly the markers present, in a fixed order', () => {
    const reply = buildStatusReply(
      input({
        cards: ids('12', '45', '46'),
        listings: [
          listing('sammel-ente', ids('12'), { matchStatus: 'pending', lastSeenAt: T - 1 }),
          listing('blue-ocean', ids('45', '46'), { matchStatus: 'bundle', available: false }),
        ],
      })
    );
    expect(cells(reply, '#12')).toEqual(['0,55 € ⏱⚠¹', '–', 'n/a', 'n/a']);
    expect(cells(reply, '#45')).toEqual(['–', 'sold out +', 'n/a', 'n/a']);
    expect(legend(reply)).toBe(
      'Legend: ⏱ older than the last check · ⚠ picture unconfirmed · + bundle'
    );
    const plain = buildStatusReply(input({ listings: [listing('sammel-ente', ids('12'))] }));
    expect(legend(plain)).toBeUndefined();
  });

  test('per shop the best listing wins: in stock beats paused beats sold out, then the lowest price', () => {
    const reply = buildStatusReply(
      input({
        listings: [
          listing('blue-ocean', ids('12'), { available: false }),
          listing('blue-ocean', ids('12'), { onHold: true }),
          listing('blue-ocean', ids('12'), euro(120)),
          listing('blue-ocean', ids('12'), euro(90)),
          listing('sammel-ente', ids('12'), { available: false }),
          listing('sammel-ente', ids('12'), { onHold: true }),
        ],
      })
    );
    expect(cells(reply)).toEqual(['paused', '0,90 €¹', 'n/a', 'n/a']);
  });

  test('a confirmed picture beats a cheaper unconfirmed one; a priced listing beats one without a price', () => {
    const picture = buildStatusReply(
      input({
        listings: [
          listing('blue-ocean', ids('12'), { matchStatus: 'unconfirmed', ...euro(90) }),
          listing('blue-ocean', ids('12'), { matchStatus: 'confirmed', ...euro(120) }),
        ],
      })
    );
    expect(cells(picture)).toEqual(['–', '1,20 €¹', 'n/a', 'n/a']);
    const price = buildStatusReply(
      input({
        listings: [
          listing('blue-ocean', ids('12'), { price: null }),
          listing('blue-ocean', ids('12'), euro(120)),
        ],
      })
    );
    expect(cells(price)).toEqual(['–', '1,20 €¹', 'n/a', 'n/a']);
  });

  test('a disabled shop is an n/a column and its stored listings are not shown', () => {
    const reply = buildStatusReply(
      input({
        latest: run({ ...okRun, shops: { ...okRun.shops, ebay: { listings: 4 } } }),
        listings: [listing('ebay', ids('12'))],
      })
    );
    expect(reply.content).toContain('⚪ eBay: not enabled');
    expect(tableLines(reply)[0]).toContain('eBay');
    expect(cells(reply)).toEqual(['–', '–', 'n/a', 'n/a']);
    expect(reply.embeds).toEqual([]);
  });

  test('link numbers run across rows and columns and continue past 9 as ¹⁰ ¹¹', () => {
    const cards = Array.from({ length: 6 }, (_, i) => cid(String(i + 1)));
    const reply = buildStatusReply(
      input({
        cards,
        names: new Map(),
        listings: cards.flatMap((c) => [listing('sammel-ente', [c]), listing('blue-ocean', [c])]),
      })
    );
    expect(cells(reply, '#1')).toEqual(['0,55 €¹', '0,55 €²', 'n/a', 'n/a']);
    expect(cells(reply, '#5')).toEqual(['0,55 €⁹', '0,55 €¹⁰', 'n/a', 'n/a']);
    expect(cells(reply, '#6')).toEqual(['0,55 €¹¹', '0,55 €¹²', 'n/a', 'n/a']);
    expect(links(reply)).toHaveLength(12);
    expect(links(reply)[9]).toMatch(
      /^¹⁰ \[#5 · blue-ocean · 0,55 €\]\(https:\/\/example\.com\/\d+\)$/
    );
    expect(superscript(1234567890)).toBe('¹²³⁴⁵⁶⁷⁸⁹⁰');
  });

  test('an in-stock cell with an invalid URL gets no number and the next one takes it', () => {
    const reply = buildStatusReply(
      input({
        cards: ids('12', '45'),
        names: new Map(),
        listings: [
          listing('sammel-ente', ids('12'), { url: 'javascript:alert(1)' }),
          listing('blue-ocean', ids('12'), { url: `https://example.com/${'a'.repeat(600)}` }),
          listing('sammel-ente', ids('45'), { url: 'https://ok.example/45' }),
        ],
      })
    );
    expect(cells(reply, '#12')).toEqual(['0,55 €', '0,55 €', 'n/a', 'n/a']);
    expect(cells(reply, '#45')).toEqual(['0,55 €¹', '–', 'n/a', 'n/a']);
    expect(links(reply)).toEqual(['¹ [#45 · sammel-ente · 0,55 €](https://ok.example/45)']);
  });

  test('a URL with brackets or spaces and a name with brackets cannot break the markdown link', () => {
    const reply = buildStatusReply(
      input({
        names: new Map([[cid('12'), 'Squid [gold]']]),
        listings: [listing('sammel-ente', ids('12'), { url: 'https://e.example/a (b)' })],
      })
    );
    expect(links(reply)).toEqual([
      '¹ [#12 Squid \\[gold\\] · sammel-ente · 0,55 €](https://e.example/a%20%28b%29)',
    ]);
  });

  test('without any in-stock cell there is no embed', () => {
    const reply = buildStatusReply(
      input({ listings: [listing('sammel-ente', ids('12'), { available: false })] })
    );
    expect(reply.embeds).toEqual([]);
  });

  test('long names are shortened so a row stays within PC width, the id is never cut', () => {
    const reply = buildStatusReply(
      input({
        cards: ids('12', 'XXL1'),
        names: new Map([
          [cid('12'), 'A very long card name that goes on and on and on and on and on and on'],
          [cid('XXL1'), 'Ender Dragon'],
        ]),
        latest: run(allRun),
        enabledShops: ALL,
        listings: [listing('ebay', ids('12'), { matchStatus: 'pending', lastSeenAt: T - 1 })],
      })
    );
    const lines = tableLines(reply);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(90);
    expect(row(reply, '#12')![0]).toMatch(/^#12 A very long card name.*…$/);
    expect(row(reply, '#XXL1')![0]).toBe('#XXL1 Ender Dragon');
    // The link has room for more of the name, up to 60 characters.
    expect(links(reply)[0]).toStartWith(
      '¹ [#12 A very long card name that goes on and on and on and on… · eBay'
    );
    expect(row(reply, '#12')![0]!.length).toBeLessThan(60);
  });

  test('a backtick in a name cannot close the code block', () => {
    const reply = buildStatusReply(input({ names: new Map([[cid('12'), 'Sq```uid']]) }));
    expect(reply.content.split('\n').filter((l) => l.includes(FENCE))).toEqual([FENCE, FENCE]);
  });

  test('a card without a known name shows only its number; LE and XXL keep their prefix', () => {
    expect(row(buildStatusReply(input({ names: new Map() })))![0]).toBe('#12');
    const reply = buildStatusReply(input({ cards: ids('LE8', 'XXL1'), names: new Map() }));
    expect(cells(reply, '#LE8')).toEqual(['–', '–', 'n/a', 'n/a']);
    expect(cells(reply, '#XXL1')).toEqual(['–', '–', 'n/a', 'n/a']);
  });

  test('a last check older than the success window is warned about in the header', () => {
    const warning = `⚠️ The last check is older than ${DAYS} days; stock may have changed.`;
    const old = buildStatusReply(input({ now: T + LAST_SUCCESS_WINDOW_MS + 1 }));
    expect(old.content.split('\n')[1]).toBe(warning);
    expect(buildStatusReply(input({ now: T + LAST_SUCCESS_WINDOW_MS })).content).not.toContain(
      warning
    );
  });

  test('before the first check every enabled cell is ?', () => {
    const reply = buildStatusReply(
      input({
        latest: { summary: undefined, newerUnreadable: false },
        listings: [listing('sammel-ente', ids('12'))],
      })
    );
    expect(reply.content.split('\n').slice(0, 3)).toEqual([
      'Your missing cards (1)',
      'No check has run yet.',
      '',
    ]);
    expect(cells(reply)).toEqual(['?', '?', 'n/a', 'n/a']);
    expect(reply.embeds).toEqual([]);
  });

  test('with only unreadable check records every enabled cell is ?', () => {
    const reply = buildStatusReply(
      input({ latest: { summary: undefined, newerUnreadable: true } })
    );
    expect(reply.content.split('\n').slice(0, 2)).toEqual([
      'Your missing cards (1)',
      '⚠️ No readable check record.',
    ]);
    expect(cells(reply)).toEqual(['?', '?', 'n/a', 'n/a']);
  });

  test('an unreadable latest record is announced and the one before is shown', () => {
    const reply = buildStatusReply(input({ latest: { summary: okRun, newerUnreadable: true } }));
    expect(reply.content.split('\n').slice(0, 3)).toEqual([
      `Your missing cards (1) · last check <t:${S}:R>`,
      '⚠️ The latest check record could not be read; showing the one before.',
      '',
    ]);
  });

  test('a failed check run is shown after the header, its error cut to 100', () => {
    const reply = buildStatusReply(input({ latest: run({ ...okRun, error: 'y'.repeat(150) }) }));
    expect(reply.content.split('\n')[1]).toBe(`❌ Last check failed: ${'y'.repeat(100)}`);
    expect(reply.content).not.toContain('y'.repeat(101));
  });

  test('an empty list has its own text and no embed', () => {
    expect(buildStatusReply(input({ cards: [] }))).toEqual({
      content: 'You have no missing cards on your list.',
      embeds: [],
    });
  });

  test('a long table keeps whole rows within 2000, closes the block and counts the rest', () => {
    const cards = Array.from({ length: 228 }, (_, i) => cid(String(i + 1)));
    const listings = cards.map((c) => listing('blue-ocean', [c], { matchStatus: 'pending' }));
    const reply = buildStatusReply(input({ cards, listings, names: new Map() }));
    expect(reply.content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    const shown = tableLines(reply).length - 1;
    expect(shown).toBeGreaterThan(10);
    const lines = reply.content.split('\n');
    expect(lines.slice(-3)).toEqual([
      FENCE,
      `… and ${228 - shown} more cards`,
      'Legend: ⚠ picture unconfirmed',
    ]);
    // Only the shown rows are numbered and linked.
    expect(links(reply)).toHaveLength(shown);
    expect(cells(reply, `#${shown}`)).toEqual(['–', `0,55 € ⚠${superscript(shown)}`, 'n/a', 'n/a']);
  });

  test('a reply of exactly 2000 characters is kept whole; one more cuts a row', () => {
    const make = (count: number, error: string) =>
      buildStatusReply(
        input({
          cards: Array.from({ length: count }, (_, i) => cid(String(i + 1))),
          names: new Map(),
          latest: run({
            ...okRun,
            shops: { ...okRun.shops, 'blue-ocean': { listings: 0, error } },
          }),
          lastSuccess: { 'blue-ocean': T - 3_600_000 },
        })
      );
    let count = 1;
    let gap = DISCORD_MESSAGE_LIMIT - make(count, '').content.length;
    while (gap < 1 || gap > 99) {
      count++;
      gap = DISCORD_MESSAGE_LIMIT - make(count, '').content.length;
      expect(count).toBeLessThan(200);
    }
    const exact = make(count, 'x'.repeat(gap));
    expect(exact.content.length).toBe(DISCORD_MESSAGE_LIMIT);
    expect(tableLines(exact)).toHaveLength(count + 1);
    expect(exact.content).not.toContain('more cards');
    const over = make(count, 'x'.repeat(gap + 1));
    expect(over.content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(
      over.content.endsWith(`${FENCE}\n… and ${count + 1 - tableLines(over).length} more cards`)
    ).toBe(true);
    expect(tableLines(over).length).toBeLessThan(count + 1);
  });

  test('a link list of exactly 4096 characters is kept whole; one more ends in "… and N more links"', () => {
    const cards = Array.from({ length: 10 }, (_, i) => cid(String(i + 1)));
    const make = (pads: number[]) =>
      buildStatusReply(
        input({
          cards,
          names: new Map(),
          listings: cards.map((c, i) =>
            listing('sammel-ente', [c], { url: `https://e.example/${'a'.repeat(pads[i]!)}` })
          ),
        })
      );
    const pads = cards.map(() => 350);
    let extra = EMBED_DESCRIPTION_LIMIT - description(make(pads))!.length;
    expect(extra).toBeGreaterThan(0);
    for (let i = 0; extra > 0; i = (i + 1) % pads.length, extra--) pads[i]!++;
    const exact = make(pads);
    expect(description(exact)!.length).toBe(EMBED_DESCRIPTION_LIMIT);
    expect(links(exact)).toHaveLength(10);
    pads[9]!++;
    const over = make(pads);
    expect(description(over)!.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
    expect(links(over)).toHaveLength(10);
    expect(links(over)[9]).toBe('… and 1 more links');
    expect(links(over)[8]).toStartWith('⁹ [#9 ');
  });

  test('many long links: whole links are kept and the rest counted', () => {
    const cards = Array.from({ length: 20 }, (_, i) => cid(String(i + 1)));
    const reply = buildStatusReply(
      input({
        cards,
        names: new Map(),
        listings: cards.flatMap((c) =>
          (['sammel-ente', 'blue-ocean'] as const).map((shop) =>
            listing(shop, [c], { url: `https://e.example/${'b'.repeat(400)}` })
          )
        ),
      })
    );
    const list = links(reply);
    expect(description(reply)!.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
    const numbered = tableLines(reply).length - 1;
    expect(list.at(-1)).toBe(`… and ${numbered * 2 - (list.length - 1)} more links`);
    expect(list.slice(0, -1).every((l) => l.endsWith(`${'b'.repeat(400)})`))).toBe(true);
  });

  test('the longest possible head with rows too long to show still fits', () => {
    const error = 'e'.repeat(500);
    const reply = buildStatusReply(
      input({
        cards: ids('12', '45'),
        enabledShops: ALL,
        latest: {
          summary: {
            ...okRun,
            error,
            shops: {
              'sammel-ente': { listings: 0, error },
              'blue-ocean': { listings: 0, error },
              'collect-it': { listings: 0, error },
              ebay: { listings: 0, error },
            },
          },
          newerUnreadable: true,
        },
        lastSuccess: { 'sammel-ente': null, 'blue-ocean': null, 'collect-it': null, ebay: null },
        names: new Map([
          [cid('12'), 'n'.repeat(3000)],
          [cid('45'), 'n'.repeat(3000)],
        ]),
      })
    );
    expect(reply.content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
  });
});

describe('needsLastSuccess', () => {
  test('only an enabled shop whose latest check failed or did not run needs it', () => {
    const enabled = ['sammel-ente', 'blue-ocean', 'ebay'] as const;
    expect(needsLastSuccess(blueFailed, 'blue-ocean', enabled)).toBe(true);
    expect(needsLastSuccess(blueFailed, 'ebay', enabled)).toBe(true);
    expect(needsLastSuccess(blueFailed, 'sammel-ente', enabled)).toBe(false);
    expect(needsLastSuccess(blueFailed, 'ebay', ['sammel-ente'])).toBe(false);
    expect(needsLastSuccess(undefined, 'ebay', enabled)).toBe(false);
  });
});
