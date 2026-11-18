import { describe, expect, test } from 'bun:test';
import { ButtonBuilder, ButtonStyle } from 'discord.js';
import type { ShopId } from '../shops/types';
import { cid, ids } from '../../test/cardIds';
import { euro, runOf, storedListing as listing, T } from '../../test/listings';
import {
  buildCardReply,
  linkRows,
  MAX_BUTTONS_PER_ROW,
  type CardInput,
  type CardReply,
} from './cardReply';

const S = T / 1000;
const ALL: readonly ShopId[] = ['sammel-ente', 'blue-ocean', 'collect-it', 'ebay'];
const KLEINANZEIGEN_12 = 'https://www.kleinanzeigen.de/s-lego-minecraft-karte-12/k0';

function input(over: Partial<CardInput> = {}): CardInput {
  return {
    card: cid('12'),
    name: 'Squid',
    reference: null,
    shop: null,
    latest: { summary: runOf(ALL), newerUnreadable: false },
    enabledShops: ALL,
    listings: [],
    now: T + 60_000,
    ...over,
  };
}

const embed = (reply: CardReply) => reply.embeds[0]!.toJSON();
const lines = (reply: CardReply) => embed(reply).description!.split('\n');
const buttons = (reply: CardReply) =>
  reply.components.flatMap(
    (row) => row.toJSON().components as unknown as { label: string; url: string; style: number }[]
  );
const links = (reply: CardReply) => buttons(reply).map((b) => [b.label, b.url]);

describe('buildCardReply', () => {
  test('a card in every shop: a line and an Open button per shop, then Kleinanzeigen', () => {
    const reply = buildCardReply(
      input({
        listings: [
          listing('sammel-ente', ids('12'), { url: 'https://se.example/12' }),
          listing('blue-ocean', ids('12'), { ...euro(80), url: 'https://bo.example/12' }),
          listing('collect-it', ids('12'), { ...euro(99), url: 'https://ci.example/12' }),
          listing('ebay', ids('12'), { ...euro(120), url: 'https://eb.example/12' }),
        ],
      })
    );
    expect(embed(reply).title).toBe('#12 Squid');
    expect(lines(reply)).toEqual([
      '✅ sammel-ente: 0,55 €',
      '✅ blue-ocean: 0,80 €',
      '✅ collect-it: 0,99 €',
      '✅ eBay: 1,20 €',
      '',
      `Last check <t:${S}:R>`,
    ]);
    expect(reply.components).toHaveLength(1);
    expect(links(reply)).toEqual([
      ['Open sammel-ente', 'https://se.example/12'],
      ['Open blue-ocean', 'https://bo.example/12'],
      ['Open collect-it', 'https://ci.example/12'],
      ['Open eBay', 'https://eb.example/12'],
      ['Kleinanzeigen #12', KLEINANZEIGEN_12],
    ]);
    expect(buttons(reply).every((b) => b.style === ButtonStyle.Link)).toBe(true);
  });

  test('every state: sold out, ended, paused, held back, not listed, ?, not enabled', () => {
    const now = T + 60_000;
    const state = (over: Partial<CardInput>) => lines(buildCardReply(input(over)));
    const one = (l: ReturnType<typeof listing>) => state({ shop: l.shop, listings: [l], now })[0];
    expect(one(listing('ebay', ids('12'), { available: false }))).toBe('❌ eBay: sold out');
    expect(one(listing('ebay', ids('12'), { format: 'auction', auctionEndsAt: now - 1 }))).toBe(
      '❌ eBay: ended'
    );
    expect(one(listing('ebay', ids('12'), { onHold: true }))).toBe('⏸️ eBay: paused');
    expect(one(listing('ebay', ids('12'), { matchStatus: 'mismatch' }))).toBe(
      '⚠️ eBay: held back (picture shows another card)'
    );
    expect(state({ shop: 'ebay' })[0]).toBe('➖ eBay: not listed');
    expect(
      state({
        shop: 'ebay',
        latest: { summary: runOf(['sammel-ente'], ['ebay']), newerUnreadable: false },
      })[0]
    ).toBe('❔ eBay: ? (its last check failed or did not run)');
    expect(state({ enabledShops: ['sammel-ente'] }).slice(1, 4)).toEqual([
      '⚪ blue-ocean: not enabled',
      '⚪ collect-it: not enabled',
      '⚪ eBay: not enabled',
    ]);
  });

  test('a held-back or paused listing gets no Open button, only Kleinanzeigen', () => {
    const reply = buildCardReply(
      input({
        listings: [
          listing('ebay', ids('12'), { matchStatus: 'mismatch' }),
          listing('blue-ocean', ids('12'), { onHold: true }),
        ],
      })
    );
    expect(links(reply)).toEqual([['Kleinanzeigen #12', KLEINANZEIGEN_12]]);
  });

  test('notes: older than the last check, bundle, picture unconfirmed', () => {
    const last = { ...runOf(ALL), startedAt: T + 10 };
    const reply = buildCardReply(
      input({
        latest: { summary: last, newerUnreadable: false },
        listings: [
          listing('sammel-ente', ids('12')),
          listing('blue-ocean', ids('12', '13'), { lastSeenAt: T + 10, matchStatus: 'bundle' }),
          listing('ebay', ids('12'), { lastSeenAt: T + 10, matchStatus: 'unconfirmed' }),
        ],
      })
    );
    expect(lines(reply).slice(0, 4)).toEqual([
      '✅ sammel-ente: 0,55 € · older than the last check',
      '✅ blue-ocean: 0,55 € · bundle',
      '➖ collect-it: not listed',
      '✅ eBay: 0,55 € · picture unconfirmed',
    ]);
  });

  test('without a price an in-stock listing says in stock', () => {
    const reply = buildCardReply(
      input({ shop: 'sammel-ente', listings: [listing('sammel-ente', ids('12'), { price: null })] })
    );
    expect(lines(reply)[0]).toBe('✅ sammel-ente: in stock');
  });

  test('several available listings give the offer count; the button opens the cheapest', () => {
    const reply = buildCardReply(
      input({
        shop: 'ebay',
        listings: [
          listing('ebay', ids('12'), { ...euro(300), url: 'https://eb.example/a' }),
          listing('ebay', ids('12'), {
            ...euro(150),
            matchStatus: 'unconfirmed',
            url: 'https://eb.example/cheap',
          }),
          listing('ebay', ids('12'), { ...euro(200), url: 'https://eb.example/b' }),
          // Not offered: held back and paused are left out of the count and the link.
          listing('ebay', ids('12'), { ...euro(1), matchStatus: 'mismatch' }),
          listing('ebay', ids('12'), { ...euro(1), onHold: true }),
        ],
      })
    );
    // The line shows the best listing (picture backed), the count and the cheapest price.
    expect(lines(reply)[0]).toBe('✅ eBay: 2,00 € (3 offers, from 1,50 €)');
    expect(links(reply)).toEqual([['Open eBay', 'https://eb.example/cheap']]);
  });

  test('offers at the shown price give no "from"', () => {
    const reply = buildCardReply(
      input({
        shop: 'ebay',
        listings: [listing('ebay', ids('12'), euro(300)), listing('ebay', ids('12'), euro(300))],
      })
    );
    expect(lines(reply)[0]).toBe('✅ eBay: 3,00 € (2 offers)');
  });

  test('an invalid URL gets no button; the cheapest valid one is linked instead', () => {
    const only = buildCardReply(
      input({
        shop: 'ebay',
        listings: [listing('ebay', ids('12'), { url: 'javascript:alert(1)' })],
      })
    );
    expect(lines(only)[0]).toBe('✅ eBay: 0,55 €');
    expect(only.components).toEqual([]);
    const two = buildCardReply(
      input({
        shop: 'ebay',
        listings: [
          listing('ebay', ids('12'), { ...euro(10), url: `https://eb.example/${'x'.repeat(600)}` }),
          listing('ebay', ids('12'), { ...euro(20), url: 'https://eb.example/ok' }),
        ],
      })
    );
    expect(links(two)).toEqual([['Open eBay', 'https://eb.example/ok']]);
  });

  test('shop: shows that shop only, with its button and no Kleinanzeigen', () => {
    const reply = buildCardReply(
      input({
        shop: 'blue-ocean',
        listings: [
          listing('sammel-ente', ids('12')),
          listing('blue-ocean', ids('12'), { url: 'https://bo.example/12' }),
        ],
      })
    );
    expect(lines(reply)).toEqual(['✅ blue-ocean: 0,55 €', '', `Last check <t:${S}:R>`]);
    expect(links(reply)).toEqual([['Open blue-ocean', 'https://bo.example/12']]);
  });

  test('no readable run: every shop is ?, and the last line says so', () => {
    const none = buildCardReply(input({ latest: { summary: undefined, newerUnreadable: false } }));
    expect(lines(none)[0]).toBe('❔ sammel-ente: ? (its last check failed or did not run)');
    expect(lines(none).at(-1)).toBe('No check has run yet.');
    const unreadable = buildCardReply(
      input({ latest: { summary: undefined, newerUnreadable: true } })
    );
    expect(lines(unreadable).at(-1)).toBe('⚠️ No readable check record.');
  });

  test('the title without a name is the number only', () => {
    expect(embed(buildCardReply(input({ name: null }))).title).toBe('#12');
  });

  test('the reference picture is the thumbnail; none or an invalid one gives none', () => {
    const ref = 'https://shop-sammel-ente.de/media/12.jpg';
    expect(embed(buildCardReply(input({ reference: ref }))).thumbnail?.url).toBe(ref);
    expect(embed(buildCardReply(input())).thumbnail).toBeUndefined();
    expect(embed(buildCardReply(input({ reference: 'ftp://x/12.jpg' }))).thumbnail).toBeUndefined();
  });
});

describe('linkRows', () => {
  const button = (n: number) =>
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(`b${n}`)
      .setURL(`https://x.example/${n}`);

  test('at most five buttons per row', () => {
    expect(MAX_BUTTONS_PER_ROW).toBe(5);
    const rows = linkRows(Array.from({ length: 11 }, (_, i) => button(i)));
    expect(rows.map((r) => r.components.length)).toEqual([5, 5, 1]);
    expect(
      linkRows([button(1), button(2), button(3), button(4), button(5), button(6)]).map(
        (r) => r.components.length
      )
    ).toEqual([5, 1]);
  });

  test('no buttons, no rows', () => {
    expect(linkRows([])).toEqual([]);
  });
});
