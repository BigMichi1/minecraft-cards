import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { eq } from 'drizzle-orm';
import { db, initializeDatabase } from '../database/db';
import { cards, listingCards, listings, runs } from '../database/schema/index';
import { catalogManager } from '../database/catalogManager';
import { listingManager } from '../database/listingManager';
import { runManager } from '../database/runManager';
import type { DownloadFn } from '../notify/pictures';
import { SHOP_IDS } from '../shops/types';
import { cid } from '../../test/cardIds';
import { runOf, storedListing as listing } from '../../test/listings';
import logger from '../utils/logger';
import { data, execute, type CardContext } from './card';
import { UNKNOWN_COLLECTION } from './collectionOption';

const REF = 'https://shop-sammel-ente.de/media/mnc3_12.jpg';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

type Embed = { toJSON(): { title?: string; description?: string; thumbnail?: { url: string } } };
type Payload = {
  content?: string;
  flags?: unknown;
  embeds?: Embed[];
  components?: { toJSON(): { components: { label: string; url: string }[] } }[];
  files?: { name: string }[];
};

let deferred: Payload[] = [];
let edits: Payload[] = [];
let downloads: string[] = [];

const okDownload: DownloadFn = async (url) => {
  downloads.push(url);
  return PNG;
};

function ctx(over: Partial<CardContext> = {}): CardContext {
  return {
    enabledShops: new Map([['lego-minecraft-3', ['sammel-ente', 'blue-ocean']]]),
    download: okDownload,
    ...over,
  };
}

function command(
  number: string,
  shop: string | null = null,
  collection: string = 'lego-minecraft-3'
) {
  const interaction = {
    user: { id: 'u1' },
    deferred: false,
    replied: false,
    commandName: 'card',
    isChatInputCommand: () => true,
    options: {
      getString: (name: string) =>
        name === 'number'
          ? number
          : name === 'shop'
            ? shop
            : name === 'collection'
              ? collection
              : null,
    },
    deferReply: async (p: Payload) => {
      deferred.push(p);
      interaction.deferred = true;
    },
    editReply: async (p: Payload) => {
      edits.push(p);
    },
    reply: async () => {
      throw new Error('reply after deferReply');
    },
  };
  return interaction as unknown as ChatInputCommandInteraction;
}

const last = () => edits[edits.length - 1]!;
const embed = () => last().embeds![0]!.toJSON();
const links = () =>
  (last().components ?? []).flatMap((r) => r.toJSON().components.map((c) => [c.label, c.url]));

function setReference(url: string | null) {
  db.update(cards)
    .set({ name: 'Squid', shopImageUrl: url })
    .where(eq(cards.cardId, cid('12')))
    .run();
}

describe('/card', () => {
  beforeAll(() => {
    initializeDatabase();
  });

  beforeEach(() => {
    deferred = [];
    edits = [];
    downloads = [];
    db.delete(listingCards).run();
    db.delete(listings).run();
    db.delete(runs).run();
    db.delete(cards).run();
    catalogManager.seedIfEmpty();
    runManager.record(runOf(['sammel-ente', 'blue-ocean']));
  });

  test('a card of a collection whose card list is not loaded yet says so', async () => {
    await execute(command('12', null, 'lego-minecraft-1'), ctx());
    expect(last().content).toBe(
      'The card list of LEGO Minecraft Serie 1 is not loaded yet: it comes from laststicker with the next check (/admin catalog sync loads it now).'
    );
  });

  test('declares number (required) and shop with a choice per shop', () => {
    const json = data.toJSON();
    expect(json.name).toBe('card');
    const [collection, number, shop] = json.options as unknown as {
      name: string;
      required?: boolean;
      choices?: { name: string; value: string }[];
    }[];
    expect(collection).toMatchObject({ name: 'collection', required: true });
    expect(number!.name).toBe('number');
    expect(number!.required).toBe(true);
    expect(shop!.name).toBe('shop');
    expect(shop!.required).toBeFalsy();
    expect(shop!.choices!.map((c) => c.value)).toEqual([...SHOP_IDS]);
    expect(shop!.choices!.map((c) => c.name)).toEqual([
      'sammel-ente',
      'blue-ocean',
      'collect-it',
      'eBay',
    ]);
  });

  test('an unknown collection is refused before any card is read', async () => {
    const read = spyOn(catalogManager, 'getCard');
    try {
      await execute(command('12', null, 'lego-minecraft-9'), ctx());
      expect(read).not.toHaveBeenCalled();
      expect(edits).toEqual([{ content: UNKNOWN_COLLECTION, embeds: [], components: [] }]);
    } finally {
      read.mockRestore();
    }
  });

  test('defers ephemeral and answers with the card embed and its buttons', async () => {
    setReference(null);
    const stored = listing('sammel-ente', [cid('12')], { url: 'https://se.example/12' });
    const read = spyOn(listingManager, 'listingsForCards').mockImplementation(() => [stored]);
    try {
      await execute(command('#012'), ctx());
      expect(read).toHaveBeenCalledWith('lego-minecraft-3', [cid('12')]);
    } finally {
      read.mockRestore();
    }
    expect(deferred).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(embed().title).toBe('#12 Squid');
    expect(embed().description!.split('\n').slice(0, 4)).toEqual([
      '✅ sammel-ente: 0,55 €',
      '➖ blue-ocean: not listed',
      '⚪ collect-it: not enabled',
      '⚪ eBay: not enabled',
    ]);
    expect(links()).toEqual([
      ['Open sammel-ente', 'https://se.example/12'],
      ['Kleinanzeigen #12', 'https://www.kleinanzeigen.de/s-lego-minecraft-karte-12/k0'],
    ]);
    // No reference picture: nothing downloaded, nothing attached.
    expect(downloads).toEqual([]);
    expect(embed().thumbnail).toBeUndefined();
  });

  test.each([
    ['9999', 'Unknown card: 9999'],
    ['abc', 'Unknown card: abc'],
    ['LE0', 'Unknown card: LE0'],
    ['  12x ', 'Unknown card: 12x'],
  ])('%p answers unknown card and names the token', async (token, text) => {
    await execute(command(token), ctx());
    expect(last()).toEqual({ content: text, embeds: [], components: [] });
  });

  test('shop: limits the reply to that shop', async () => {
    await execute(command('12', 'blue-ocean'), ctx());
    expect(embed().description!.split('\n')[0]).toBe('➖ blue-ocean: not listed');
    expect(embed().description!.split('\n')).toHaveLength(3);
  });

  test('a shop that is not enabled answers not enabled', async () => {
    await execute(command('12', 'ebay'), ctx());
    expect(last()).toEqual({ content: 'eBay is not enabled.', embeds: [], components: [] });
  });

  test("a shop the card's collection does not use is not enabled there", async () => {
    catalogManager.syncCollection(
      'lego-minecraft-2',
      [
        {
          cardId: cid('12'),
          name: 'X',
          kind: 'Oberwelt Karte',
          variant: 'Basis Karte',
          puzzle: false,
          pictureUrl: null,
        },
      ],
      1
    );
    const enabled = {
      enabledShops: new Map([['lego-minecraft-2' as const, ['sammel-ente'] as const]]),
    };
    await execute(command('12', 'blue-ocean', 'lego-minecraft-2'), ctx(enabled));
    expect(last()).toEqual({ content: 'blue-ocean is not enabled.', embeds: [], components: [] });
  });

  test('a shop value that is no shop is refused', async () => {
    await execute(command('12', 'amazon'), ctx());
    expect(last()).toEqual({ content: 'Unknown shop: amazon', embeds: [], components: [] });
  });

  test('the reference picture is attached as the thumbnail', async () => {
    setReference(REF);
    await execute(command('12'), ctx());
    expect(downloads).toEqual([REF]);
    expect(last().files!.map((f) => f.name)).toEqual(['reference-1.png']);
    expect(embed().thumbnail?.url).toBe('attachment://reference-1.png');
  });

  test('a picture that cannot be downloaded falls back to its URL', async () => {
    setReference(REF);
    const warn = spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      await execute(
        command('12'),
        ctx({
          download: async () => {
            throw new Error('HTTP 503');
          },
        })
      );
    } finally {
      warn.mockRestore();
    }
    expect(embed().thumbnail?.url).toBe(REF);
    expect(last().files ?? []).toEqual([]);
  });

  test('a placeholder or shared reference is never shown', async () => {
    setReference('https://shop-sammel-ente.de/media/mnc3_leer.jpg');
    await execute(command('12'), ctx());
    expect(embed().thumbnail).toBeUndefined();
    setReference(REF);
    db.update(cards)
      .set({ shopImageUrl: REF })
      .where(eq(cards.cardId, cid('13')))
      .run();
    await execute(command('12'), ctx());
    expect(embed().thumbnail).toBeUndefined();
    expect(downloads).toEqual([]);
  });

  test('without a download function it uses the bounded picture download', async () => {
    // No reference, so nothing is fetched: only the default wiring is exercised.
    setReference(null);
    await execute(command('12'), {
      enabledShops: new Map([['lego-minecraft-3', ['sammel-ente']]]),
    });
    expect(embed().title).toBe('#12 Squid');
  });

  describe('errors', () => {
    let log: ReturnType<typeof spyOn>;
    afterEach(() => log.mockRestore());

    test('a deferReply that throws is logged and does not reject', async () => {
      log = spyOn(logger, 'log').mockImplementation(() => logger);
      const warn = spyOn(logger, 'warn').mockImplementation(() => logger);
      const interaction = command('12');
      (interaction as unknown as { deferReply: () => Promise<void> }).deferReply = async () => {
        throw new Error('Unknown interaction');
      };
      try {
        await expect(execute(interaction, ctx())).resolves.toBeUndefined();
        expect(
          log.mock.calls.some((c: unknown[]) =>
            String(c[1]).includes('/card 12 failed: Unknown interaction')
          )
        ).toBe(true);
        // The error reply cannot be delivered either; that is a warning, not a rejection.
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
      expect(edits).toEqual([]);
    });

    test('a failing read answers with an error reply and logs', async () => {
      log = spyOn(logger, 'log').mockImplementation(() => logger);
      const read = spyOn(listingManager, 'listingsForCards').mockImplementation(() => {
        throw new Error('db locked');
      });
      try {
        await execute(command('12'), ctx());
      } finally {
        read.mockRestore();
      }
      expect(embed().description).toBe('Could not load this card. Please try again later.');
      expect(log.mock.calls.some((c: unknown[]) => String(c[1]).includes('/card 12 failed'))).toBe(
        true
      );
    });
  });
});
