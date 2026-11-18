import { describe, expect, test } from 'bun:test';
import type { CardId } from '../cards/cardId';
import type { RunSummary } from '../check/runner';
import type { StoredListing } from '../database/listingManager';
import type { ShopId } from '../shops/types';
import { LAST_SUCCESS_WINDOW_MS } from '../database/runManager';
import { DISCORD_MESSAGE_LIMIT } from '../utils/messageLimit';
import { cid, ids } from '../../test/cardIds';
import { buildStatusReply, needsLastSuccess, type StatusInput } from './missingStatus';

const S = 1_800_000_000; // seconds
const T = S * 1000;

let nextId = 1;
function listing(shop: ShopId, cards: CardId[], over: Partial<StoredListing> = {}): StoredListing {
  return {
    id: nextId++,
    shop,
    url: `https://example/${nextId}`,
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
const cardLine = (reply: string) => reply.split('\n').find((l) => l.startsWith('#12'));

describe('buildStatusReply', () => {
  test('a normal reply has the header, the shop lines and one line per card', () => {
    const reply = buildStatusReply(
      input({
        listings: [
          listing('sammel-ente', ids('12')),
          listing('blue-ocean', ids('12'), { available: false }),
        ],
      })
    );
    expect(reply.split('\n')).toEqual([
      `Your missing cards (1) · last check <t:${S}:R>`,
      '',
      '✅ sammel-ente: 251 listings',
      '✅ blue-ocean: 206 listings',
      '⚪ collect-it: not enabled',
      '⚪ eBay: not enabled',
      '',
      '#12 Squid: sammel-ente 0,55 € in stock · blue-ocean sold out',
    ]);
  });

  test('collect-it has its own shop line and card entry, between blue-ocean and eBay', () => {
    const reply = buildStatusReply(
      input({
        latest: run({ ...okRun, shops: { ...okRun.shops, 'collect-it': { listings: 235 } } }),
        enabledShops: ['sammel-ente', 'blue-ocean', 'collect-it'],
        listings: [
          listing('collect-it', ids('12'), { price: { cents: 49, currency: 'EUR' } }),
          listing('blue-ocean', ids('12'), { available: false }),
        ],
      })
    );
    expect(reply.split('\n').slice(2, 6)).toEqual([
      '✅ sammel-ente: 251 listings',
      '✅ blue-ocean: 206 listings',
      '✅ collect-it: 235 listings',
      '⚪ eBay: not enabled',
    ]);
    expect(cardLine(reply)).toBe('#12 Squid: blue-ocean sold out · collect-it 0,49 € in stock');
  });

  test('a shop whose last check failed shows the error and marks its entries as of the last success', () => {
    const reply = buildStatusReply(
      input({
        latest: run(blueFailed),
        lastSuccess: { 'blue-ocean': T - 3_600_000 },
        listings: [listing('blue-ocean', ids('12'))],
      })
    );
    expect(reply).toContain(`❌ blue-ocean: error <t:${S}:R> – ${'x'.repeat(100)}`);
    expect(reply).not.toContain('x'.repeat(101));
    expect(cardLine(reply)).toBe(`#12 Squid: blue-ocean 0,55 € in stock (as of <t:${S - 3600}:R>)`);
  });

  test('a failed shop without a success in the last 7 days says so on its entries', () => {
    const reply = buildStatusReply(
      input({
        latest: run(blueFailed),
        lastSuccess: { 'blue-ocean': null },
        listings: [listing('blue-ocean', ids('12'))],
      })
    );
    const days = LAST_SUCCESS_WINDOW_MS / 86_400_000;
    expect(cardLine(reply)).toBe(
      `#12 Squid: blue-ocean 0,55 € in stock (no successful check in ${days} days)`
    );
  });

  test('a shop whose last success was not looked up is a wiring error, not a guess', () => {
    expect(() => buildStatusReply(input({ latest: run(blueFailed) }))).toThrow(
      /blue-ocean.*not looked up/
    );
  });

  test('a failed shop without a listing of the card is unknown, never "not listed"', () => {
    const reply = buildStatusReply(
      input({
        latest: run(blueFailed),
        lastSuccess: { 'blue-ocean': null },
        listings: [listing('sammel-ente', ids('12'))],
      })
    );
    expect(cardLine(reply)).toBe(
      '#12 Squid: sammel-ente 0,55 € in stock · blue-ocean unknown (check failed)'
    );
    const alone = buildStatusReply(
      input({ latest: run(blueFailed), lastSuccess: { 'blue-ocean': null } })
    );
    expect(cardLine(alone)).toBe('#12 Squid: blue-ocean unknown (check failed)');
  });

  test('an enabled shop missing from the last check is unknown for cards it has no listing of', () => {
    const reply = buildStatusReply(
      input({ enabledShops: ['sammel-ente', 'blue-ocean', 'ebay'], lastSuccess: { ebay: null } })
    );
    expect(reply).toContain('⚠️ eBay: not checked');
    expect(cardLine(reply)).toBe('#12 Squid: eBay unknown (not checked)');
  });

  test('a shop missing from the last check marks its stored entries as of its last success', () => {
    const reply = buildStatusReply(
      input({
        enabledShops: ['sammel-ente', 'blue-ocean', 'ebay'],
        lastSuccess: { ebay: T - 86_400_000 },
        listings: [listing('ebay', ids('12'))],
      })
    );
    expect(cardLine(reply)).toBe(`#12 Squid: eBay 0,55 € in stock (as of <t:${S - 86_400}:R>)`);
  });

  test('an entry last seen before the last success of its shop is as of when it was last seen', () => {
    const reply = buildStatusReply(
      input({
        enabledShops: ['sammel-ente', 'blue-ocean', 'ebay'],
        lastSuccess: { ebay: T - 3_600_000 },
        listings: [listing('ebay', ids('12'), { lastSeenAt: T - 86_400_000 })],
      })
    );
    expect(cardLine(reply)).toBe(`#12 Squid: eBay 0,55 € in stock (as of <t:${S - 86_400}:R>)`);
  });

  test('a last check older than the success window is warned about in the header', () => {
    const days = LAST_SUCCESS_WINDOW_MS / 86_400_000;
    const warning = `⚠️ The last check is older than ${days} days; stock may have changed.`;
    const old = buildStatusReply(input({ now: T + LAST_SUCCESS_WINDOW_MS + 1 }));
    expect(old.split('\n')[1]).toBe(warning);
    expect(cardLine(old)).toBe('#12 Squid: not listed in any shop');
    expect(buildStatusReply(input({ now: T + LAST_SUCCESS_WINDOW_MS }))).not.toContain(warning);
  });

  test('a disabled shop says so and its stored listings are not shown', () => {
    const reply = buildStatusReply(
      input({
        latest: run({ ...okRun, shops: { ...okRun.shops, ebay: { listings: 4 } } }),
        listings: [listing('ebay', ids('12'))],
      })
    );
    expect(reply).toContain('⚪ eBay: not enabled');
    expect(cardLine(reply)).toBe('#12 Squid: not listed in any shop');
  });

  test('a held listing reads as paused, never as in stock', () => {
    const reply = buildStatusReply(
      input({ listings: [listing('sammel-ente', ids('12'), { onHold: true })] })
    );
    expect(cardLine(reply)).toBe('#12 Squid: sammel-ente paused (reported)');
    expect(reply).not.toContain('in stock');
  });

  test('a bundle is marked', () => {
    const reply = buildStatusReply(
      input({
        cards: ids('12', '45'),
        listings: [listing('blue-ocean', ids('12', '45'), { matchStatus: 'bundle' })],
      })
    );
    expect(reply).toContain('#12 Squid: blue-ocean 0,55 € in stock (bundle)');
    expect(reply).toContain('#45: blue-ocean 0,55 € in stock (bundle)');
    expect(reply).not.toContain('picture unconfirmed');
  });

  test('a single-card listing whose picture is not backed is marked unconfirmed', () => {
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
      expect(cardLine(reply)).toBe('#12 Squid: blue-ocean 0,55 € in stock (picture unconfirmed)');
    }
    const confirmed = buildStatusReply(
      input({ listings: [listing('blue-ocean', ids('12'), { matchStatus: 'confirmed' })] })
    );
    expect(cardLine(confirmed)).toBe('#12 Squid: blue-ocean 0,55 € in stock');
  });

  test('per shop the best listing wins: in stock beats paused beats sold out, then the lowest price', () => {
    const reply = buildStatusReply(
      input({
        listings: [
          listing('blue-ocean', ids('12'), { available: false }),
          listing('blue-ocean', ids('12'), { onHold: true }),
          listing('blue-ocean', ids('12'), { price: { cents: 120, currency: 'EUR' } }),
          listing('blue-ocean', ids('12'), { price: { cents: 90, currency: 'EUR' } }),
          listing('sammel-ente', ids('12'), { available: false }),
          listing('sammel-ente', ids('12'), { onHold: true }),
        ],
      })
    );
    expect(cardLine(reply)).toBe(
      '#12 Squid: sammel-ente paused (reported) · blue-ocean 0,90 € in stock'
    );
  });

  test('a confirmed picture beats a cheaper unconfirmed one in the same tier', () => {
    const reply = buildStatusReply(
      input({
        listings: [
          listing('blue-ocean', ids('12'), {
            matchStatus: 'unconfirmed',
            price: { cents: 90, currency: 'EUR' },
          }),
          listing('blue-ocean', ids('12'), {
            matchStatus: 'confirmed',
            price: { cents: 120, currency: 'EUR' },
          }),
        ],
      })
    );
    expect(cardLine(reply)).toBe('#12 Squid: blue-ocean 1,20 € in stock');
  });

  test('a listing the latest successful check did not return is marked and ranks below seen ones', () => {
    const unseen = { lastSeenAt: T - 1 };
    const alone = buildStatusReply(input({ listings: [listing('blue-ocean', ids('12'), unseen)] }));
    expect(cardLine(alone)).toBe('#12 Squid: blue-ocean 0,55 € in stock (not seen in last check)');
    const both = buildStatusReply(
      input({
        listings: [
          listing('blue-ocean', ids('12'), { ...unseen, price: { cents: 30, currency: 'EUR' } }),
          listing('blue-ocean', ids('12'), { price: { cents: 90, currency: 'EUR' } }),
        ],
      })
    );
    expect(cardLine(both)).toBe('#12 Squid: blue-ocean 0,90 € in stock');
  });

  test('a card with no listing anywhere is not listed in any shop', () => {
    expect(cardLine(buildStatusReply(input()))).toBe('#12 Squid: not listed in any shop');
  });

  test('before the first check the reply says so', () => {
    const reply = buildStatusReply(
      input({ latest: { summary: undefined, newerUnreadable: false } })
    );
    expect(reply.split('\n')).toEqual([
      'Your missing cards (1)',
      'No check has run yet.',
      '',
      '#12 Squid: not checked yet',
    ]);
  });

  test('with only unreadable check records every card is unknown', () => {
    const reply = buildStatusReply(
      input({ latest: { summary: undefined, newerUnreadable: true } })
    );
    expect(reply.split('\n')).toEqual([
      'Your missing cards (1)',
      '⚠️ No readable check record.',
      '',
      '#12 Squid: unknown',
    ]);
  });

  test('an unreadable latest record is announced and the one before is shown', () => {
    const reply = buildStatusReply(input({ latest: { summary: okRun, newerUnreadable: true } }));
    expect(reply.split('\n').slice(0, 3)).toEqual([
      `Your missing cards (1) · last check <t:${S}:R>`,
      '⚠️ The latest check record could not be read; showing the one before.',
      '',
    ]);
  });

  test('a failed check run is shown after the header, its error cut to 100', () => {
    const reply = buildStatusReply(input({ latest: run({ ...okRun, error: 'y'.repeat(150) }) }));
    expect(reply.split('\n')[1]).toBe(`❌ Last check failed: ${'y'.repeat(100)}`);
    expect(reply).not.toContain('y'.repeat(101));
  });

  test('an auction that has ended since the last check is not in stock', () => {
    const reply = buildStatusReply(
      input({
        enabledShops: ['ebay'],
        listings: [listing('ebay', ids('12'), { format: 'auction', auctionEndsAt: T + 30_000 })],
        latest: run({ ...okRun, shops: { ...okRun.shops, ebay: { listings: 1 } } }),
      })
    );
    expect(cardLine(reply)).toBe('#12 Squid: eBay auction ended');
    expect(reply).not.toContain('in stock');
  });

  test('an in-stock listing beats an ended auction of the same shop; a running auction is in stock', () => {
    const latest = run({ ...okRun, shops: { ebay: { listings: 2 } } });
    const ended = listing('ebay', ids('12'), { format: 'auction', auctionEndsAt: T + 30_000 });
    const reply = buildStatusReply(
      input({
        enabledShops: ['ebay'],
        latest,
        listings: [
          ended,
          listing('ebay', ids('12'), {
            format: 'fixed_price',
            price: { cents: 400, currency: 'EUR' },
          }),
        ],
      })
    );
    expect(cardLine(reply)).toBe('#12 Squid: eBay 4,00 € in stock');
    const running = buildStatusReply(
      input({
        enabledShops: ['ebay'],
        latest,
        listings: [listing('ebay', ids('12'), { format: 'auction', auctionEndsAt: T + 120_000 })],
      })
    );
    expect(cardLine(running)).toBe('#12 Squid: eBay 0,55 € in stock');
  });

  test('an in-stock listing without a price shows no price and ranks after priced ones', () => {
    const alone = buildStatusReply(
      input({ listings: [listing('blue-ocean', ids('12'), { price: null })] })
    );
    expect(cardLine(alone)).toBe('#12 Squid: blue-ocean in stock');
    const both = buildStatusReply(
      input({
        listings: [
          listing('blue-ocean', ids('12'), { price: null }),
          listing('blue-ocean', ids('12'), { price: { cents: 120, currency: 'EUR' } }),
        ],
      })
    );
    expect(cardLine(both)).toBe('#12 Squid: blue-ocean 1,20 € in stock');
  });

  test('an empty list has its own text', () => {
    expect(buildStatusReply(input({ cards: [] }))).toBe('You have no missing cards on your list.');
  });

  test('a card without a known name shows only its number', () => {
    expect(buildStatusReply(input({ names: new Map() }))).toContain('#12: not listed in any shop');
  });

  test('LE and XXL cards keep their prefix', () => {
    const reply = buildStatusReply(input({ cards: ids('LE8', 'XXL1'), names: new Map() }));
    expect(reply).toContain('LE8: not listed in any shop');
    expect(reply).toContain('XXL1: not listed in any shop');
  });

  test('a long list stays within the Discord limit and says how many cards were left out', () => {
    const cards = Array.from({ length: 228 }, (_, i) => cid(String(i + 1)));
    const listings = cards.map((c) => listing('blue-ocean', [c]));
    const reply = buildStatusReply(input({ cards, listings, names: new Map() }));
    expect(reply.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    const shown = reply.split('\n').filter((l) => /^#\d+: /.test(l)).length;
    expect(reply.endsWith(`… and ${228 - shown} more cards`)).toBe(true);
    expect(shown).toBeGreaterThan(10);
  });

  test('the longest possible head with cards too long to show still fits', () => {
    const error = 'e'.repeat(500);
    const reply = buildStatusReply(
      input({
        cards: ids('12', '45'),
        enabledShops: ['sammel-ente', 'blue-ocean', 'ebay'],
        latest: {
          summary: {
            ...okRun,
            error,
            shops: {
              'sammel-ente': { listings: 0, error },
              'blue-ocean': { listings: 0, error },
              ebay: { listings: 0, error },
            },
          },
          newerUnreadable: true,
        },
        lastSuccess: { 'sammel-ente': null, 'blue-ocean': null, ebay: null },
        names: new Map([
          [cid('12'), 'n'.repeat(3000)],
          [cid('45'), 'n'.repeat(3000)],
        ]),
      })
    );
    expect(reply.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(reply.endsWith('… and 2 more cards')).toBe(true);
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
