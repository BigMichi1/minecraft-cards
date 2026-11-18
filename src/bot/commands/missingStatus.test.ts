import { describe, expect, test } from 'bun:test';
import type { CardId } from '../cards/cardId';
import type { RunSummary } from '../check/runner';
import type { StoredListing } from '../database/listingManager';
import type { ShopId } from '../shops/types';
import { DISCORD_MESSAGE_LIMIT } from '../utils/messageLimit';
import { cid, ids } from '../../test/cardIds';
import { buildStatusReply, type StatusInput } from './missingStatus';

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

function input(over: Partial<StatusInput> = {}): StatusInput {
  return {
    cards: ids('12'),
    last: okRun,
    lastSuccess: {},
    listings: [],
    names: new Map([[cid('12'), 'Squid']]),
    now: T + 60_000,
    ...over,
  };
}

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
      '⚠️ eBay: not checked',
      '',
      '#12 Squid: sammel-ente 0,55 € in stock · blue-ocean sold out',
    ]);
  });

  test('a shop whose last check failed shows the error and marks its entries as of the last success', () => {
    const reply = buildStatusReply(
      input({
        last: {
          ...okRun,
          shops: { ...okRun.shops, 'blue-ocean': { listings: 0, error: 'x'.repeat(150) } },
        },
        lastSuccess: { 'blue-ocean': T - 3_600_000 },
        listings: [listing('blue-ocean', ids('12'))],
      })
    );
    expect(reply).toContain(`❌ blue-ocean: error <t:${S}:R> – ${'x'.repeat(100)}`);
    expect(reply).not.toContain('x'.repeat(101));
    expect(reply).toContain(`#12 Squid: blue-ocean 0,55 € in stock (as of <t:${S - 3600}:R>)`);
  });

  test('a failed shop that never succeeded says so on its entries', () => {
    const reply = buildStatusReply(
      input({
        last: { ...okRun, shops: { 'blue-ocean': { listings: 0, error: 'down' } } },
        listings: [listing('blue-ocean', ids('12'))],
      })
    );
    expect(reply).toContain('blue-ocean 0,55 € in stock (never checked successfully)');
  });

  test('a held listing reads as paused, never as in stock', () => {
    const reply = buildStatusReply(
      input({ listings: [listing('sammel-ente', ids('12'), { onHold: true })] })
    );
    expect(reply).toContain('#12 Squid: sammel-ente paused (reported)');
    expect(reply).not.toContain('in stock');
  });

  test('a bundle is marked', () => {
    const reply = buildStatusReply(
      input({ cards: ids('12', '45'), listings: [listing('blue-ocean', ids('12', '45'))] })
    );
    expect(reply).toContain('#12 Squid: blue-ocean 0,55 € in stock (bundle)');
    expect(reply).toContain('#45: blue-ocean 0,55 € in stock (bundle)');
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
    expect(reply).toContain(
      '#12 Squid: sammel-ente paused (reported) · blue-ocean 0,90 € in stock'
    );
  });

  test('a card with no listing anywhere is not listed in any shop', () => {
    expect(buildStatusReply(input())).toContain('#12 Squid: not listed in any shop');
  });

  test('before the first check the reply says so', () => {
    const reply = buildStatusReply(input({ last: undefined }));
    expect(reply.split('\n')).toEqual([
      'Your missing cards (1)',
      'No check has run yet.',
      '',
      '#12 Squid: not checked yet',
    ]);
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
  test('a shop missing from the last check marks its stored entries as of its last success', () => {
    const reply = buildStatusReply(
      input({
        lastSuccess: { ebay: T - 86_400_000 },
        listings: [listing('ebay', ids('12'))],
      })
    );
    expect(reply).toContain('⚠️ eBay: not checked');
    expect(reply).toContain(`#12 Squid: eBay 0,55 € in stock (as of <t:${S - 86_400}:R>)`);
  });

  test('a shop missing from the last check that never succeeded says so', () => {
    const reply = buildStatusReply(input({ listings: [listing('ebay', ids('12'))] }));
    expect(reply).toContain('eBay 0,55 € in stock (never checked successfully)');
  });

  test('an auction that has ended since the last check is not in stock', () => {
    const reply = buildStatusReply(
      input({
        listings: [listing('ebay', ids('12'), { format: 'auction', auctionEndsAt: T + 30_000 })],
        lastSuccess: { ebay: T },
        last: { ...okRun, shops: { ...okRun.shops, ebay: { listings: 1 } } },
      })
    );
    expect(reply).toContain('#12 Squid: eBay auction ended');
    expect(reply).not.toContain('in stock');
  });
});
