import { describe, expect, test } from 'bun:test';
import { HttpError, USER_AGENT } from '../utils/http';
import { readFixture } from '../../test/shopHelpers';
import { cid } from '../../test/cardIds';
import { MINECRAFT_CARD_IDS, normalizeCardIdIn, TURBO_ATTAX_CARD_IDS } from '../cards/cardId';
import {
  CatalogLayoutError,
  fetchLaststickerSet,
  laststickerSetUrl,
  parseLaststickerPage,
} from './laststicker';

const fixture = readFixture('laststicker-lego-minecraft-3.html');

/** A page with the tooltip id and the given table rows (each `<td>` cells joined). */
function page(rows: string[][], { tooltip = 'tooltip7', table = true } = {}): string {
  const body = rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`);
  const tableHtml = table
    ? `<table id="checklist"><thead><tr><th>Nr.</th></tr></thead><tbody>${body.join('')}</tbody></table>`
    : '<p>Wartung</p>';
  return `<div class="cards_tooltip cards_info" rel="${tooltip}">${tableHtml}</div>`;
}

const cells = (id: string, name: string) => [
  id,
  `<a href="/x">${name}</a>`,
  'Characterkarten',
  'Basis Karte',
  '1',
  '2',
  '3',
  '1.0',
];

describe('parseLaststickerPage', () => {
  const parsed = parseLaststickerPage(fixture);

  test('reads the set id and every row, in page order', () => {
    expect(parsed.setId).toBe(12125);
    expect(parsed.rows).toHaveLength(251);
    expect(parsed.rows[0]!.cardId).toBe(cid('1'));
    expect(parsed.rows[227]!.cardId).toBe(cid('228'));
    expect(parsed.rows[228]!.cardId).toBe(cid('LE1'));
    expect(parsed.rows.at(-1)!.cardId).toBe(cid('XXL1'));
  });

  test('a row carries name, section, type and the lowercase picture URL', () => {
    expect(parsed.rows[0]).toEqual({
      cardId: cid('1'),
      name: 'Alex',
      kind: 'Characterkarten',
      variant: 'Basis Karte',
      puzzle: false,
      pictureUrl: 'https://www.laststicker.com/i/cards/12125/1.jpg',
    });
    const byId = new Map(parsed.rows.map((r) => [r.cardId, r]));
    expect(byId.get(cid('154'))).toMatchObject({
      name: 'The Overworld 1',
      kind: 'Puzzlekarten',
      puzzle: true,
    });
    // The piece marker and the section agree on every row: 36 puzzle cards, #154-#189.
    const puzzles = parsed.rows.filter((r) => r.puzzle);
    expect(puzzles.map((r) => r.cardId)).toEqual(
      Array.from({ length: 36 }, (_, i) => cid(String(154 + i)))
    );
    expect(puzzles.every((r) => r.kind === 'Puzzlekarten')).toBe(true);
    expect(byId.get(cid('104'))).toMatchObject({ name: 'Ghast', variant: 'Lava Karte' });
    expect(byId.get(cid('LE10'))!.pictureUrl).toBe(
      'https://www.laststicker.com/i/cards/12125/le10.jpg'
    );
    expect(byId.get(cid('XXL1'))).toMatchObject({
      kind: 'Oversize Karte',
      variant: 'Limitierte XXL Karte',
      pictureUrl: 'https://www.laststicker.com/i/cards/12125/xxl1.jpg',
    });
  });

  test('a piece marker makes a puzzle card whatever the section is called', () => {
    const { rows } = parseLaststickerPage(
      page([
        ['154', '<a>The Overworld</a><div><div class="pz"></div>1</div>', 'Puzzles', 'Basis Karte'],
      ])
    );
    expect(rows[0]).toMatchObject({ name: 'The Overworld 1', puzzle: true });
  });

  test("the collection's id rule reads the numbers", () => {
    const rule = (raw: string) => (raw === 'L-7' ? cid('LE7') : null);
    const { rows } = parseLaststickerPage(page([cells('L-7', 'A')]), rule);
    expect(rows[0]!.cardId).toBe(cid('LE7'));
  });

  test('names are trimmed and HTML-decoded', () => {
    const { rows } = parseLaststickerPage(page([cells('12', '  Steve &amp; Alex ')]));
    expect(rows[0]!.name).toBe('Steve & Alex');
  });

  test.each([
    ['no checklist table', page([cells('1', 'A')], { table: false }), 'no checklist table'],
    ['no rows', page([]), 'no rows'],
    ['a short row', page([['1', 'A', 'Characterkarten']]), 'row 1 has 3 cells'],
    ['an unreadable number', page([cells('Nr. X', 'A')]), 'row 1: no card number "Nr. X"'],
    ['a duplicate number', page([cells('1', 'A'), cells('001', 'B')]), 'card 1 twice'],
    ['an empty name', page([cells('1', ' ')]), 'row 1: no name'],
    [
      'an empty section',
      page([['1', '<a>A</a>', ' ', 'Basis Karte']]),
      'row 1: no section or type',
    ],
    [
      'an empty type',
      page([['1', '<a>A</a>', 'Characterkarten', '']]),
      'row 1: no section or type',
    ],
    ['no set id', page([cells('1', 'A')], { tooltip: 'x' }), 'no set id'],
  ])('%s is a CatalogLayoutError', (_, html, message) => {
    expect(() => parseLaststickerPage(html)).toThrow(CatalogLayoutError);
    expect(() => parseLaststickerPage(html)).toThrow(message);
  });

  test('a laststicker value in an error is clipped to 200 characters', () => {
    const long = 'X'.repeat(500);
    try {
      parseLaststickerPage(page([cells(long, 'A')]));
      throw new Error('no error');
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogLayoutError);
      expect((error as Error).message.length).toBeLessThan(260);
    }
  });
});

describe('the series 1 and 2 pages (2026-11-24)', () => {
  test('the series 1 page parses: 283 cards, German names, Puzzlekarte puzzle cards', () => {
    const { setId, rows } = parseLaststickerPage(readFixture('laststicker-lego-minecraft-1.html'));
    expect(setId).toBe(10289);
    expect(rows).toHaveLength(283);
    expect(rows.filter((r) => r.kind === 'Puzzlekarte')).toHaveLength(27);
    expect(rows.map((r) => r.cardId)).toContain(cid('LE27'));
    expect(rows.at(-1)).toMatchObject({
      cardId: cid('XXL2'),
      name: 'Brennender Zombie',
      pictureUrl: 'https://www.laststicker.com/i/cards/10289/xxl2.jpg',
    });
  });

  test('the series 2 page parses with its XXL alias and without scans', () => {
    const { rows } = parseLaststickerPage(
      readFixture('laststicker-lego-minecraft-2.html'),
      undefined,
      { scans: false, numberAliases: { XXL: 'XXL1' } }
    );
    expect(rows).toHaveLength(297);
    expect(rows.at(-1)).toMatchObject({ cardId: cid('XXL1'), name: 'Ghast', pictureUrl: null });
    expect(rows.every((r) => r.pictureUrl === null)).toBe(true);
  });

  test('an alias is read from the map itself, never from an inherited key', () => {
    const html = readFixture('laststicker-lego-minecraft-2.html').replace(
      '<td>1</td>',
      '<td>constructor</td>'
    );
    expect(() => parseLaststickerPage(html, undefined, { numberAliases: { XXL: 'XXL1' } })).toThrow(
      CatalogLayoutError
    );
  });

  test('fetchLaststickerSet passes the options on', async () => {
    const { rows } = await fetchLaststickerSet(
      'blue_ocean_lego_minecraft_tnt_boom_bastic',
      { scans: false, numberAliases: { XXL: 'XXL1' } },
      async () => new Response(readFixture('laststicker-lego-minecraft-2.html'))
    );
    expect(rows.at(-1)).toMatchObject({ cardId: cid('XXL1'), pictureUrl: null });
  });

  test('a bare number no alias covers is still a CatalogLayoutError', () => {
    expect(() => parseLaststickerPage(readFixture('laststicker-lego-minecraft-2.html'))).toThrow(
      'no card number "XXL"'
    );
  });
});

describe('the Turbo Attax 2026 page (2026-11-25)', () => {
  const html = readFixture('laststicker-turbo-attax-2026.html');
  const ta = (raw: string) => normalizeCardIdIn(TURBO_ATTAX_CARD_IDS, raw);

  test("parses with Turbo Attax's id rule: 422 cards, codes and relics, no #135", () => {
    const { setId, rows } = parseLaststickerPage(html, ta);
    expect(setId).toBe(12348);
    expect(rows).toHaveLength(422);
    const ids = rows.map((r) => r.cardId);
    expect(ids).not.toContain(cid('135'));
    for (const id of ['1', '353', 'LE18', 'BG2', 'GG8', 'GU11', 'SUN11', 'MR-HAM', 'RR-ALB']) {
      expect(ids).toContain(cid(id));
    }
    expect(rows.some((r) => r.puzzle)).toBe(false);
    expect(rows.find((r) => r.cardId === cid('MR-HAM'))).toMatchObject({
      name: 'Lewis Hamilton',
      kind: 'Manufactured Relics',
      pictureUrl: 'https://www.laststicker.com/i/cards/12348/mr-ham.jpg',
    });
    expect(rows.find((r) => r.cardId === cid('LE1'))).toMatchObject({
      name: 'Oscar Piastri',
      kind: '-',
      variant: 'Limited Edition',
    });
  });

  test("Minecraft's id rule cannot read it", () => {
    expect(() =>
      parseLaststickerPage(html, (raw) => normalizeCardIdIn(MINECRAFT_CARD_IDS, raw))
    ).toThrow(CatalogLayoutError);
  });

  test('fetchLaststickerSet reads with the rule it is given', async () => {
    const { rows } = await fetchLaststickerSet(
      'topps_formula_1_turbo_attax_2026',
      {},
      async () => new Response(html),
      TURBO_ATTAX_CARD_IDS
    );
    expect(rows).toHaveLength(422);
  });
});

describe('fetchLaststickerSet', () => {
  test('requests the set page with the bot User-Agent', async () => {
    const seen: { url: string; agent: string | null }[] = [];
    const result = await fetchLaststickerSet(
      'blue_ocean_lego_minecraft_on_fire',
      {},
      async (url, init) => {
        seen.push({ url, agent: new Headers(init?.headers).get('User-Agent') });
        return new Response(fixture);
      }
    );
    expect(laststickerSetUrl('blue_ocean_lego_minecraft_on_fire')).toBe(
      'https://www.laststicker.com/de/cards/blue_ocean_lego_minecraft_on_fire/'
    );
    expect(seen).toEqual([
      {
        url: 'https://www.laststicker.com/de/cards/blue_ocean_lego_minecraft_on_fire/',
        agent: USER_AGENT,
      },
    ]);
    expect(result.rows).toHaveLength(251);
  });

  test('an HTTP error rejects', async () => {
    await expect(
      fetchLaststickerSet('x', {}, async () => new Response('busy', { status: 503 }))
    ).rejects.toBeInstanceOf(HttpError);
  });
});
