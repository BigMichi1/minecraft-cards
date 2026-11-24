import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { db, initializeDatabase } from '../database/db';
import { imageEmbeddings } from '../database/schema/index';
import type { Listing } from '../shops/types';
import {
  allowedImageUrl,
  pacedImageFetch,
  createCachedEmbedder,
  createTransformersEmbedder,
  DEFAULT_IMAGE_MATCH_THRESHOLD,
  DEFAULT_IMAGE_MODEL,
  ImageUnavailableError,
  loadReferenceSet,
  matchListing,
  ModelError,
  MAX_IMAGE_BYTES,
  pooledOutput,
  type ImageEmbedder,
} from './embedder';
import type { ReferenceSet, ReferenceVector } from './identify';
import { cid } from '../../test/cardIds';
import { HttpError } from '../utils/http';

/** Fake inner embedder: returns `vectors[url]` (or `fallback`) and counts calls. */
function fakeEmbedder(
  vectors: Record<string, number[]>,
  model = 'fake-model',
  fallback = [1, 0]
): ImageEmbedder & { calls: number } {
  const fake = {
    model,
    calls: 0,
    async embed(url: string): Promise<Float32Array> {
      fake.calls++;
      return new Float32Array(vectors[url] ?? fallback);
    },
  };
  return fake;
}

const throwingEmbedder: ImageEmbedder = {
  model: 'broken',
  async embed(): Promise<Float32Array> {
    throw new ModelError('broken: onnx runtime missing');
  },
};

const blue12: Listing = {
  shop: 'blue-ocean',
  url: 'https://www.blue-ocean.de/nr.-9-squid-2dd00088-12',
  title: 'Nr. 9 Squid LEGO Minecraft TCC',
  cardIds: [cid('12')],
  cardName: null,
  imageUrl: 'img12',
  price: { cents: 80, currency: 'EUR' },
  available: true,
  format: 'shop',
  auctionEndsAt: null,
  idConflict: false,
};
const bundle: Listing = {
  ...blue12,
  shop: 'ebay',
  cardIds: [cid('12'), cid('13')],
  format: 'fixed_price',
};

const fakeSame = fakeEmbedder({ ref12: [1, 0], img12: [1, 0] });
const fakeDifferent = fakeEmbedder({ ref12: [1, 0], img12: [0, 1] });

describe('defaults', () => {
  test('model and threshold are set', () => {
    expect(DEFAULT_IMAGE_MODEL).toMatch(/^Xenova\//);
    expect(DEFAULT_IMAGE_MATCH_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_IMAGE_MATCH_THRESHOLD).toBeLessThan(1);
  });
});

describe('createCachedEmbedder', () => {
  beforeAll(() => {
    initializeDatabase();
  });

  beforeEach(() => {
    db.delete(imageEmbeddings).run();
  });

  test('embeds a url once and then reads it from the database', async () => {
    const fake = fakeEmbedder({ u: [0.6, 0.8] });
    const cached = createCachedEmbedder(fake);
    await cached.embed('u');
    const second = await cached.embed('u');
    expect(fake.calls).toBe(1);
    expect(Array.from(second)).toEqual(Array.from(new Float32Array([0.6, 0.8])));
    expect(cached.model).toBe('fake-model');
  });

  test('survives a new embedder instance (the cache is the database)', async () => {
    await createCachedEmbedder(fakeEmbedder({ u: [1, 0] })).embed('u');
    const fresh = fakeEmbedder({ u: [1, 0] });
    await createCachedEmbedder(fresh).embed('u');
    expect(fresh.calls).toBe(0);
  });

  test('a model change re-embeds and overwrites the row', async () => {
    await createCachedEmbedder(fakeEmbedder({ u: [1, 0] }, 'old-model')).embed('u');
    const next = fakeEmbedder({ u: [0, 1] }, 'new-model');
    const vec = await createCachedEmbedder(next).embed('u');
    expect(next.calls).toBe(1);
    expect(Array.from(vec)).toEqual([0, 1]);
    const rows = db.select().from(imageEmbeddings).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe('new-model');
  });

  test('a failing inner embedder throws and stores nothing', async () => {
    await expect(createCachedEmbedder(throwingEmbedder).embed('u')).rejects.toThrow(/onnx/);
    expect(db.select().from(imageEmbeddings).all()).toHaveLength(0);
  });
});

describe('matchListing', () => {
  test('same picture confirms, different picture does not', async () => {
    expect((await matchListing(blue12, 'ref12', fakeSame, 0.85)).status).toBe('confirmed');
    const different = await matchListing(blue12, 'ref12', fakeDifferent, 0.85);
    expect(different.status).toBe('unconfirmed');
    expect(different.similarity).toBeCloseTo(0);
  });

  test('reports the similarity and compares with >= threshold', async () => {
    const result = await matchListing(blue12, 'ref12', fakeSame, 1);
    expect(result).toEqual({
      status: 'confirmed',
      similarity: expect.closeTo(1, 5),
      picture: null,
    });
  });

  test('an id conflict is never confirmed', async () => {
    expect(
      (await matchListing({ ...blue12, idConflict: true }, 'ref12', fakeSame, 0.85)).status
    ).toBe('unconfirmed');
  });

  test('a failing or missing model is model_unavailable, never thrown', async () => {
    expect(await matchListing(blue12, 'ref12', throwingEmbedder, 0.85)).toEqual({
      status: 'model_unavailable',
      similarity: null,
      picture: null,
    });
    expect((await matchListing(blue12, 'ref12', null, 0.85)).status).toBe('model_unavailable');
  });

  test('onUnavailable receives the status and reason instead of a per-listing log line', async () => {
    const reasons: string[] = [];
    const onUnavailable = (status: string, reason: string) => reasons.push(`${status} ${reason}`);
    await matchListing(blue12, 'ref12', null, 0.85, { onUnavailable });
    await matchListing(blue12, 'ref12', throwingEmbedder, 0.85, { onUnavailable });
    await matchListing(blue12, 'ref12', fakeSame, 0.85, { onUnavailable });
    expect(reasons).toEqual([
      'model_unavailable no image model loaded',
      'model_unavailable broken: onnx runtime missing',
    ]);
  });

  test('a picture that cannot be loaded is image_unavailable', async () => {
    const noPicture: ImageEmbedder = {
      model: 'm',
      embed: async () => {
        throw new ImageUnavailableError('HTTP 404 for img12');
      },
    };
    expect(await matchListing(blue12, 'ref12', noPicture, 0.85)).toEqual({
      status: 'image_unavailable',
      similarity: null,
      picture: null,
    });
  });

  test('any other error (database, bug) is rethrown', async () => {
    const broken: ImageEmbedder = {
      model: 'm',
      embed: async () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
    };
    await expect(matchListing(blue12, 'ref12', broken, 0.85)).rejects.toThrow(/SQLITE_BUSY/);
  });

  test('a sammel-ente listing is compared with the reference', async () => {
    const result = await matchListing(
      { ...blue12, shop: 'sammel-ente' },
      'ref12',
      fakeEmbedder({ ref12: [1, 0], [blue12.imageUrl!]: [1, 0] }),
      0.85
    );
    expect(result).toMatchObject({ status: 'confirmed', similarity: 1 });
  });

  test('bundles and missing references skip the comparison', async () => {
    const counting = fakeEmbedder({});
    expect((await matchListing(bundle, 'ref12', counting, 0.85)).status).toBe('bundle');
    expect(await matchListing(blue12, null, counting, 0.85)).toEqual({
      status: 'no_reference',
      similarity: null,
      picture: null,
    });
    expect(counting.calls).toBe(0);
  });

  test('a listing without a picture stays unconfirmed', async () => {
    expect(await matchListing({ ...blue12, imageUrl: null }, 'ref12', fakeSame, 0.85)).toEqual({
      status: 'unconfirmed',
      similarity: null,
      picture: null,
    });
  });
});

/** A unit vector at `deg` degrees: the cosine of two of them is cos(Δdeg). */
function at(deg: number): number[] {
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad), Math.sin(rad)];
}

describe('matchListing with picture identification', () => {
  // References: 12 at 0°, 45 at 60°, puzzle card 160 at -60°.
  const references: ReferenceVector[] = [
    { cardId: cid('12'), vector: new Float32Array(at(0)), puzzle: false },
    { cardId: cid('45'), vector: new Float32Array(at(60)), puzzle: false },
    { cardId: cid('160'), vector: new Float32Array(at(-60)), puzzle: true },
  ];
  /** A complete reference set (nothing missing) of `vectors`. */
  const full = (vectors: ReferenceVector[], missing: ReferenceSet['missing'] = []) => ({
    references: async (): Promise<ReferenceSet> => ({ vectors, missing }),
  });
  const refs = full(references);
  /** The listing picture `img` at `deg`, the references at their angles. */
  const picture = (deg: number) =>
    fakeEmbedder({ ref12: at(0), ref45: at(60), ref160: at(-60), img: at(deg) });
  const titled12: Listing = { ...blue12, imageUrl: 'img' };
  const candidate: Listing = {
    ...blue12,
    shop: 'ebay',
    title: 'LEGO Minecraft On Fire Serie 3 Ender Dragon',
    cardIds: [],
    imageUrl: 'img',
    idSource: 'picture',
  };

  test('rule 1: the picture decides the title card, so it is confirmed', async () => {
    const result = await matchListing(titled12, 'ref12', picture(5), 0.78, refs);
    expect(result).toEqual({
      status: 'confirmed',
      similarity: expect.closeTo(Math.cos((5 * Math.PI) / 180), 5),
      picture: { cardId: cid('12'), similarity: expect.closeTo(Math.cos((5 * Math.PI) / 180), 5) },
    });
  });

  test('rule 2: the picture decides another card, so it is a mismatch holding both cards', async () => {
    const result = await matchListing(titled12, 'ref12', picture(60), 0.78, refs);
    expect(result).toEqual({
      status: 'mismatch',
      similarity: expect.closeTo(0.5, 5),
      picture: { cardId: cid('45'), similarity: expect.closeTo(1, 5) },
    });
  });

  test('rule 2 needs the title card to fail: a picture that also matches it is no mismatch', async () => {
    // Same art on two cards (live collect-it #59 Charged Creeper vs XXL1 Charged Creeper,
    // 0.885 vs 0.853): a twin at 30°, the picture at 25° matches the twin best and the title
    // card 12 at 0.906 too.
    const twin: ReferenceVector = {
      cardId: cid('XXL1'),
      vector: new Float32Array(at(30)),
      puzzle: false,
    };
    const result = await matchListing(titled12, 'ref12', picture(25), 0.78, {
      ...full([...references, twin]),
    });
    expect(result).toEqual({
      status: 'confirmed',
      similarity: expect.closeTo(Math.cos((25 * Math.PI) / 180), 5),
      picture: null,
      rejected: 'title_fits',
    });
  });

  test('rules 2 and 4: a card whose reference has a twin is never taken from the picture', async () => {
    // XXL1 at 64° is a twin of 45 at 60° (cos 4° = 0.998). The picture at 40° matches 45 best
    // (0.940, XXL1 0.914: a lead over the gap) and the title card 12 only at 0.766.
    const twin: ReferenceVector = {
      cardId: cid('XXL1'),
      vector: new Float32Array(at(64)),
      puzzle: false,
    };
    expect((await matchListing(titled12, 'ref12', picture(40), 0.78, refs)).status).toBe(
      'mismatch'
    );
    const withTwin = full([...references, twin]);
    expect(await matchListing(titled12, 'ref12', picture(40), 0.78, withTwin)).toEqual({
      status: 'unconfirmed',
      similarity: expect.closeTo(Math.cos((40 * Math.PI) / 180), 5),
      picture: null,
      rejected: 'twin',
    });
    expect(await matchListing(candidate, null, picture(40), 0.78, withTwin)).toEqual({
      status: 'unconfirmed',
      similarity: null,
      picture: null,
      rejected: 'twin',
    });
  });

  test('rule 1 still confirms a twin card the title names', async () => {
    const twin: ReferenceVector = {
      cardId: cid('XXL1'),
      // cos 15° = 0.966 to 12: a twin. The picture at -3° leads it by 0.047.
      vector: new Float32Array(at(15)),
      puzzle: false,
    };
    const result = await matchListing(titled12, 'ref12', picture(-3), 0.78, {
      ...full([...references, twin]),
    });
    expect(result).toMatchObject({ status: 'confirmed', picture: { cardId: '12' } });
  });

  test('rule 2 holds for an id conflict too', async () => {
    const result = await matchListing(
      { ...titled12, idConflict: true },
      'ref12',
      picture(60),
      0.78,
      refs
    );
    expect(result.status).toBe('mismatch');
  });

  test('rule 3: an undecided picture falls back to the comparison with the title card', async () => {
    // 30°: 12 and 45 both at 0.866, no lead: undecided, but the title card reaches 0.78.
    expect(await matchListing(titled12, 'ref12', picture(30), 0.78, refs)).toEqual({
      status: 'confirmed',
      similarity: expect.closeTo(Math.cos(Math.PI / 6), 5),
      picture: null,
      rejected: 'undecided',
    });
    // 70° with a threshold of 0.99: 45 leads but stays below it; 12 is far off.
    expect(await matchListing(titled12, 'ref12', picture(70), 0.99, refs)).toEqual({
      status: 'unconfirmed',
      similarity: expect.closeTo(Math.cos((70 * Math.PI) / 180), 5),
      picture: null,
      rejected: 'undecided',
    });
  });

  test('rule 5: a puzzle card is never a mismatch by picture alone', async () => {
    const result = await matchListing(titled12, 'ref12', picture(-60), 0.78, refs);
    expect(result).toEqual({
      status: 'unconfirmed',
      similarity: expect.closeTo(0.5, 5),
      picture: null,
      rejected: 'puzzle',
    });
  });

  test('rule 5: rule 1 still confirms a puzzle card the title names', async () => {
    const result = await matchListing(
      { ...titled12, cardIds: [cid('160')] },
      'ref160',
      picture(-62),
      0.78,
      refs
    );
    expect(result).toMatchObject({ status: 'confirmed', picture: { cardId: '160' } });
  });

  test('rule 4: a decided picture gives a candidate its card, confirmed', async () => {
    expect(await matchListing(candidate, null, picture(58), 0.78, refs)).toEqual({
      status: 'confirmed',
      similarity: expect.closeTo(Math.cos((2 * Math.PI) / 180), 5),
      picture: { cardId: cid('45'), similarity: expect.closeTo(Math.cos((2 * Math.PI) / 180), 5) },
    });
  });

  test('rule 4: an undecided or puzzle picture leaves a candidate without a card', async () => {
    for (const [deg, rejected] of [
      [30, 'undecided'],
      [-60, 'puzzle'],
    ] as const) {
      expect(await matchListing(candidate, null, picture(deg), 0.78, refs)).toEqual({
        status: 'unconfirmed',
        similarity: null,
        picture: null,
        rejected,
      });
    }
  });

  test('rule 4: a candidate without picture, model or loadable picture gets no card', async () => {
    expect(
      await matchListing({ ...candidate, imageUrl: null }, null, picture(58), 0.78, refs)
    ).toEqual({ status: 'unconfirmed', similarity: null, picture: null });
    expect((await matchListing(candidate, null, null, 0.78, refs)).status).toBe(
      'model_unavailable'
    );
    const noPicture: ImageEmbedder = {
      model: 'm',
      embed: async () => {
        throw new ImageUnavailableError('HTTP 404 for img');
      },
    };
    expect((await matchListing(candidate, null, noPicture, 0.78, refs)).status).toBe(
      'image_unavailable'
    );
  });

  test('a candidate without any reference loaded is not identified', async () => {
    const none = full([]);
    expect((await matchListing(candidate, null, picture(58), 0.78, none)).status).toBe(
      'unconfirmed'
    );
    expect((await matchListing(candidate, null, picture(58), 0.78)).status).toBe('unconfirmed');
  });

  describe('an incomplete reference set (R1, R2)', () => {
    const placeholder99 = { cardId: cid('99'), reason: 'placeholder' as const };
    const le10 = { cardId: cid('LE10'), reason: 'placeholder' as const };
    const failed99 = {
      cardId: cid('99'),
      reason: 'image_unavailable' as const,
      detail: 'HTTP 404',
    };

    test('a base card without a usable reference: no picture-only base card, no mismatch', async () => {
      const set = full(references, [placeholder99]);
      expect(await matchListing(candidate, null, picture(58), 0.78, set)).toEqual({
        status: 'unconfirmed',
        similarity: null,
        picture: null,
        rejected: 'incomplete',
      });
      expect(await matchListing(titled12, 'ref12', picture(60), 0.78, set)).toEqual({
        status: 'unconfirmed',
        similarity: expect.closeTo(0.5, 5),
        picture: null,
        rejected: 'incomplete',
      });
    });

    test('a missing card of another kind blocks too: kinds get confused (live data)', async () => {
      const set = full(references, [le10]);
      expect(await matchListing(candidate, null, picture(58), 0.78, set)).toMatchObject({
        status: 'unconfirmed',
        rejected: 'incomplete',
      });
      expect((await matchListing(titled12, 'ref12', picture(60), 0.78, set)).status).toBe(
        'unconfirmed'
      );
    });

    test('a reference that failed to load leaves the listing retryable, never final', async () => {
      const set = full(references, [failed99]);
      expect(await matchListing(titled12, 'ref12', picture(60), 0.78, set)).toEqual({
        status: 'image_unavailable',
        similarity: null,
        picture: null,
        rejected: 'incomplete',
      });
      expect((await matchListing(candidate, null, picture(58), 0.78, set)).status).toBe(
        'image_unavailable'
      );
      // Undecided, below the threshold: not a final unconfirmed either.
      expect((await matchListing(titled12, 'ref12', picture(70), 0.99, set)).status).toBe(
        'image_unavailable'
      );
      const model = full(references, [{ ...failed99, reason: 'model_unavailable' as const }]);
      expect((await matchListing(candidate, null, picture(58), 0.78, model)).status).toBe(
        'model_unavailable'
      );
      // A load failure of another kind still keeps a would-be mismatch retryable.
      const otherKind = full(references, [{ ...failed99, cardId: cid('LE3') }]);
      expect((await matchListing(titled12, 'ref12', picture(60), 0.78, otherKind)).status).toBe(
        'image_unavailable'
      );
    });

    test('a load failure does not hold back a title card the picture confirms', async () => {
      const set = full(references, [failed99]);
      expect(await matchListing(titled12, 'ref12', picture(5), 0.78, set)).toMatchObject({
        status: 'confirmed',
        picture: { cardId: '12' },
      });
    });
  });

  test('without references it is the plain comparison with the title card', async () => {
    expect(await matchListing(titled12, 'ref12', picture(60), 0.78)).toEqual({
      status: 'unconfirmed',
      similarity: expect.closeTo(0.5, 5),
      picture: null,
    });
  });

  test('a title card without a reference stays no_reference, the picture is not identified', async () => {
    const counting = picture(60);
    expect(await matchListing(titled12, null, counting, 0.78, refs)).toEqual({
      status: 'no_reference',
      similarity: null,
      picture: null,
    });
    expect(counting.calls).toBe(0);
  });
});

describe('loadReferenceSet', () => {
  const card = (id: string, url: string, puzzle = false, fallbackUrl: string | null = null) => ({
    cardId: cid(id),
    referenceImageUrl: url,
    source: 'laststicker' as const,
    fallbackUrl,
    puzzle,
  });

  test('embeds every usable reference, keeps the catalog gaps and adds the load failures', async () => {
    const embedder: ImageEmbedder = {
      model: 'm',
      embed: async (url) => {
        if (url === 'bad') throw new ImageUnavailableError('HTTP 404 for bad');
        if (url === 'corrupt') throw new ModelError('onnx failed on corrupt');
        return new Float32Array([1, 0]);
      },
    };
    const set = await loadReferenceSet(
      {
        usable: [
          card('12', 'ok'),
          card('13', 'bad'),
          card('14', 'corrupt'),
          card('160', 'ok2', true),
        ],
        missing: [{ cardId: cid('LE10'), reason: 'placeholder' }],
      },
      embedder
    );
    expect(set.vectors.map((v) => `${v.cardId} ${v.puzzle}`)).toEqual(['12 false', '160 true']);
    // One reference the model fails on, while others embed, is that picture's problem (R11).
    expect(set.missing).toEqual([
      { cardId: cid('LE10'), reason: 'placeholder' },
      { cardId: cid('13'), reason: 'image_unavailable', detail: 'HTTP 404 for bad' },
      { cardId: cid('14'), reason: 'image_unavailable', detail: 'onnx failed on corrupt' },
    ]);
  });

  describe('a laststicker scan with a shop picture as fallback', () => {
    const scan = 'https://www.laststicker.com/i/cards/12125/xxl1.jpg';
    const shop = 'https://shop-sammel-ente.de/xxl1.jpg';
    const failing = (error: Error): ImageEmbedder => ({
      model: 'm',
      embed: async (url) => {
        if (url === scan) throw error;
        return new Float32Array(url === shop ? [0, 1] : [1, 0]);
      },
    });
    const httpFailure = (status: number) =>
      new ImageUnavailableError(`HTTP ${status} for ${scan}`, {
        cause: new HttpError(status, scan),
      });

    test('a 404 scan falls back to the shop picture and reports the card', async () => {
      const missingScans: string[] = [];
      const set = await loadReferenceSet(
        { usable: [card('XXL1', scan, false, shop), card('12', 'ok')], missing: [] },
        failing(httpFailure(404)),
        { onScanMissing: (id) => missingScans.push(id) }
      );
      expect(set.vectors.map((v) => [v.cardId, [...v.vector]])).toEqual([
        [cid('XXL1'), [0, 1]],
        [cid('12'), [1, 0]],
      ]);
      expect(set.urls.get(cid('XXL1'))).toBe(shop);
      expect(set.urls.get(cid('12'))).toBe('ok');
      expect(missingScans).toEqual(['XXL1']);
      expect(set.missing).toEqual([]);
    });

    test('a 410 counts as missing too', async () => {
      const missingScans: string[] = [];
      const set = await loadReferenceSet(
        { usable: [card('XXL1', scan, false, shop)], missing: [] },
        failing(httpFailure(410)),
        { onScanMissing: (id) => missingScans.push(id) }
      );
      expect(set.urls.get(cid('XXL1'))).toBe(shop);
      expect(missingScans).toEqual(['XXL1']);
    });

    test('a 500 or a timeout on a scan never falls back', async () => {
      for (const error of [
        httpFailure(500),
        new ImageUnavailableError(`image ${scan}: The operation timed out.`),
      ]) {
        const missingScans: string[] = [];
        const set = await loadReferenceSet(
          { usable: [card('XXL1', scan, false, shop)], missing: [] },
          failing(error),
          { onScanMissing: (id) => missingScans.push(id) }
        );
        expect(set.vectors).toEqual([]);
        expect(set.missing).toEqual([
          { cardId: cid('XXL1'), reason: 'image_unavailable', detail: error.message },
        ]);
        expect(missingScans).toEqual([]);
      }
    });

    test('a 404 scan without fallbackUrl is no_picture (not retried) and reported', async () => {
      const missingScans: string[] = [];
      const set = await loadReferenceSet(
        { usable: [card('XXL1', scan)], missing: [] },
        failing(httpFailure(404)),
        { onScanMissing: (id) => missingScans.push(id) }
      );
      expect(set.missing).toEqual([
        { cardId: cid('XXL1'), reason: 'no_picture', detail: `HTTP 404 for ${scan}` },
      ]);
      expect(missingScans).toEqual(['XXL1']);
    });

    test('a 404 of a shop or admin picture stays image_unavailable and is no missing scan', async () => {
      const missingScans: string[] = [];
      const set = await loadReferenceSet(
        {
          usable: [{ ...card('XXL1', scan), source: 'shop' as const, fallbackUrl: null }],
          missing: [],
        },
        failing(httpFailure(404)),
        { onScanMissing: (id) => missingScans.push(id) }
      );
      expect(set.missing).toMatchObject([{ cardId: cid('XXL1'), reason: 'image_unavailable' }]);
      expect(missingScans).toEqual([]);
    });

    test('a failing fallback is image_unavailable, the scan still reported missing', async () => {
      const missingScans: string[] = [];
      const embedder: ImageEmbedder = {
        model: 'm',
        embed: async (url) => {
          if (url === scan) throw httpFailure(404);
          throw new ImageUnavailableError(`HTTP 503 for ${url}`);
        },
      };
      const set = await loadReferenceSet(
        { usable: [card('XXL1', scan, false, shop)], missing: [] },
        embedder,
        { onScanMissing: (id) => missingScans.push(id) }
      );
      expect(set.missing).toEqual([
        { cardId: cid('XXL1'), reason: 'image_unavailable', detail: `HTTP 503 for ${shop}` },
      ]);
      expect(missingScans).toEqual(['XXL1']);
    });
  });

  test('a known twin keeps its mark in the loaded set', async () => {
    const set = await loadReferenceSet(
      { usable: [{ ...card('59', 'ok'), knownTwin: true }, card('60', 'ok2')], missing: [] },
      { model: 'm', embed: async () => new Float32Array([1, 0]) }
    );
    expect(set.vectors.map((v) => [v.cardId, v.knownTwin])).toEqual([
      [cid('59'), true],
      [cid('60'), undefined],
    ]);
  });

  test('a model failing on every reference is model_unavailable (R11)', async () => {
    const set = await loadReferenceSet(
      { usable: [card('12', 'a'), card('13', 'b')], missing: [] },
      throwingEmbedder
    );
    expect(set.vectors).toEqual([]);
    expect(set.missing.map((m) => `${m.cardId} ${m.reason}`)).toEqual([
      '12 model_unavailable',
      '13 model_unavailable',
    ]);
  });

  test('a reference `skip` names is not loaded and counts as unavailable (R13)', async () => {
    const fake = fakeEmbedder({});
    const set = await loadReferenceSet(
      { usable: [card('12', 'a'), card('13', 'b')], missing: [] },
      fake,
      { skip: (url) => (url === 'b' ? 'failed in an earlier run, retried daily' : null) }
    );
    expect(fake.calls).toBe(1);
    expect(set.missing).toEqual([
      {
        cardId: cid('13'),
        reason: 'image_unavailable',
        detail: 'failed in an earlier run, retried daily',
      },
    ]);
  });

  test('loads with bounded parallelism (R13)', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: ImageEmbedder = {
      model: 'm',
      embed: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return new Float32Array([1, 0]);
      },
    };
    const usable = Array.from({ length: 12 }, (_, i) => card(String(i + 1), `u${i}`));
    const set = await loadReferenceSet({ usable, missing: [] }, slow, { concurrency: 4 });
    expect(set.vectors).toHaveLength(12);
    expect(peak).toBe(4);
    // In card order whatever finishes first.
    expect(set.vectors.map((v) => v.cardId)).toEqual(usable.map((c) => c.cardId));
  });

  test('any other error is rethrown', async () => {
    const broken: ImageEmbedder = {
      model: 'm',
      embed: async () => {
        throw new Error('SQLITE_BUSY');
      },
    };
    await expect(
      loadReferenceSet({ usable: [card('12', 'ok')], missing: [] }, broken)
    ).rejects.toThrow(/SQLITE_BUSY/);
  });
});

const IMG = 'https://shop-sammel-ente.de/media/12.jpg';

describe('pacedImageFetch', () => {
  test('passes a request on to fetch', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response('ok')) as unknown as typeof fetch
    );
    try {
      expect(await (await pacedImageFetch('https://cdn.blue-ocean.de/x.jpg')).text()).toBe('ok');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('allowedImageUrl', () => {
  test('only https on the shop, eBay and laststicker image hosts', () => {
    for (const ok of [
      'https://shop-sammel-ente.de/media/a.jpg',
      'https://cdn.blue-ocean.de/a.jpg',
      'https://www.blue-ocean.de/a.jpg',
      'https://www.collect-it.de/media/image/product/623996/md/12-squid-charakterkarte-serie-3.jpg',
      'https://i.ebayimg.com/images/g/a/s-l225.jpg',
      'https://www.laststicker.com/i/cards/12125/1.jpg',
    ]) {
      expect(allowedImageUrl(ok)).toBe(true);
    }
    for (const bad of [
      'http://shop-sammel-ente.de/a.jpg',
      'https://evil.example/a.jpg',
      'https://i.ebayimg.com.evil.example/a.jpg',
      'https://shop-sammel-ente.de:8443/a.jpg',
      'https://user:pw@i.ebayimg.com/a.jpg',
      'https://127.0.0.1/a.jpg',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(allowedImageUrl(bad)).toBe(false);
    }
  });
});

describe('createTransformersEmbedder', () => {
  const okFetch = async (): Promise<Response> => new Response(new Uint8Array([1, 2]));

  test('fetches the picture with the bot user agent and L2-normalises the output', async () => {
    const seen: { url: string; ua: string | null; bytes?: number[] }[] = [];
    const embedder = await createTransformersEmbedder(
      { model: 'm', cacheDir: '/tmp/x' },
      {
        fetchFn: async (url, init) => {
          seen.push({ url, ua: new Headers(init?.headers).get('User-Agent') });
          return new Response(new Uint8Array([7, 8]));
        },
        loadPipeline: async (model, cacheDir) => {
          expect(model).toBe('m');
          expect(cacheDir).toBe('/tmp/x');
          return async (bytes) => {
            seen[seen.length - 1]!.bytes = Array.from(bytes);
            return { data: new Float32Array([3, 4]), dims: [1, 2] };
          };
        },
      }
    );
    expect(embedder.model).toBe('m');
    const vec = await embedder.embed('https://i.ebayimg.com/1.jpg');
    expect(Array.from(vec).map((v) => Number(v.toFixed(5)))).toEqual([0.6, 0.8]);
    expect(seen).toEqual([
      {
        url: 'https://i.ebayimg.com/1.jpg',
        ua: 'minecraft-cards-bot/1.0 (+hourly stock check)',
        bytes: [7, 8],
      },
    ]);
  });

  test('takes the CLS token when the model returns hidden states', async () => {
    const embedder = await createTransformersEmbedder(
      { model: 'm', cacheDir: 'c' },
      {
        fetchFn: okFetch,
        loadPipeline: async () => async () => ({
          data: new Float32Array([0, 2, 9, 9]),
          dims: [1, 2, 2],
        }),
      }
    );
    expect(Array.from(await embedder.embed(IMG))).toEqual([0, 1]);
  });

  test('a zero vector stays zero instead of becoming NaN', async () => {
    const embedder = await createTransformersEmbedder(
      { model: 'm', cacheDir: 'c' },
      {
        fetchFn: okFetch,
        loadPipeline: async () => async () => ({ data: new Float32Array([0, 0]), dims: [1, 2] }),
      }
    );
    expect(Array.from(await embedder.embed(IMG))).toEqual([0, 0]);
  });

  test('a failed image download throws with the status', async () => {
    const embedder = await createTransformersEmbedder(
      { model: 'm', cacheDir: 'c' },
      {
        fetchFn: async () => new Response('nope', { status: 404 }),
        loadPipeline: async () => async () => ({ data: new Float32Array([1]), dims: [1, 1] }),
      }
    );
    const error = await embedder.embed('https://cdn.blue-ocean.de/missing.jpg').catch((e) => e);
    expect(error).toBeInstanceOf(ImageUnavailableError);
    expect(error.message).toMatch(/404/);
  });

  test('a 404 scan through the real download falls back to the shop picture', async () => {
    const scan = 'https://www.laststicker.com/i/cards/12125/xxl1.jpg';
    const inner = await createTransformersEmbedder(
      { model: 'm', cacheDir: 'c' },
      {
        fetchFn: async (url) =>
          url === scan ? new Response('', { status: 404 }) : new Response(new Uint8Array([7, 8])),
        loadPipeline: async () => async () => ({ data: new Float32Array([1, 0]), dims: [1, 2] }),
      }
    );
    const missing: string[] = [];
    const set = await loadReferenceSet(
      {
        usable: [
          {
            cardId: cid('XXL1'),
            referenceImageUrl: scan,
            source: 'laststicker',
            fallbackUrl: 'https://shop-sammel-ente.de/xxl1.jpg',
            puzzle: false,
          },
        ],
        missing: [],
      },
      inner,
      { onScanMissing: (id) => missing.push(id) }
    );
    expect(set.urls.get(cid('XXL1'))).toBe('https://shop-sammel-ente.de/xxl1.jpg');
    expect(missing).toEqual(['XXL1']);
  });

  test('a network failure is ImageUnavailableError', async () => {
    const embedder = await createTransformersEmbedder(
      { model: 'm', cacheDir: 'c' },
      {
        fetchFn: async () => {
          throw new TypeError('fetch failed');
        },
        loadPipeline: async () => async () => ({ data: new Float32Array([1]), dims: [1, 1] }),
      }
    );
    await expect(embedder.embed(IMG)).rejects.toBeInstanceOf(ImageUnavailableError);
  });

  test('the model failing on a picture is ModelError', async () => {
    const embedder = await createTransformersEmbedder(
      { model: 'm', cacheDir: 'c' },
      {
        fetchFn: async () => new Response(new Uint8Array(10)),
        loadPipeline: async () => async () => {
          throw new Error('onnx runtime missing');
        },
      }
    );
    const error = await embedder.embed(IMG).catch((e) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error.message).toBe('m: onnx runtime missing');
  });

  test('a picture the extractor cannot decode stays ImageUnavailableError', async () => {
    const embedder = await createTransformersEmbedder(
      { model: 'm', cacheDir: 'c' },
      {
        fetchFn: async () => new Response(new Uint8Array(10)),
        loadPipeline: async () => async () => {
          throw new ImageUnavailableError('picture could not be decoded: bad header');
        },
      }
    );
    await expect(embedder.embed(IMG)).rejects.toBeInstanceOf(ImageUnavailableError);
  });

  describe('download cap', () => {
    const extractorCalls: number[] = [];
    const load = async () => async (bytes: Uint8Array) => {
      extractorCalls.push(bytes.length);
      return { data: new Float32Array([1, 0]), dims: [1, 2] };
    };

    test('a declared size over 10 MB is refused before reading', async () => {
      const embedder = await createTransformersEmbedder(
        { model: 'm', cacheDir: 'c' },
        {
          fetchFn: async () =>
            new Response(new Uint8Array([1]), {
              headers: { 'Content-Length': String(MAX_IMAGE_BYTES + 1) },
            }),
          loadPipeline: load,
        }
      );
      await expect(embedder.embed('https://cdn.blue-ocean.de/big.jpg')).rejects.toThrow(
        /over 10485760/
      );
    });

    test('a streamed body over 10 MB without Content-Length is cut off', async () => {
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(1024 * 1024));
          if (pulled > 50) controller.close();
        },
      });
      const embedder = await createTransformersEmbedder(
        { model: 'm', cacheDir: 'c' },
        { fetchFn: async () => new Response(stream), loadPipeline: load }
      );
      await expect(embedder.embed('https://cdn.blue-ocean.de/endless.jpg')).rejects.toThrow(
        /over 10485760/
      );
      expect(pulled).toBeLessThan(20);
    });

    test('an oversize picture is image_unavailable in matchListing', async () => {
      const embedder = await createTransformersEmbedder(
        { model: 'm', cacheDir: 'c' },
        {
          fetchFn: async () =>
            new Response('x', { headers: { 'Content-Length': String(MAX_IMAGE_BYTES * 2) } }),
          loadPipeline: load,
        }
      );
      expect(await matchListing({ ...blue12, imageUrl: IMG }, IMG, embedder, 0.85)).toEqual({
        status: 'image_unavailable',
        similarity: null,
        picture: null,
      });
    });

    test('a picture under the cap still embeds', async () => {
      extractorCalls.length = 0;
      const embedder = await createTransformersEmbedder(
        { model: 'm', cacheDir: 'c' },
        { fetchFn: async () => new Response(new Uint8Array(5000)), loadPipeline: load }
      );
      expect(Array.from(await embedder.embed(IMG))).toEqual([1, 0]);
      expect(extractorCalls).toEqual([5000]);
    });
  });

  describe('image hosts and redirects', () => {
    const load = async () => async () => ({ data: new Float32Array([1, 0]), dims: [1, 2] });
    function routes(map: Record<string, () => Response>) {
      const seen: { url: string; redirect: RequestInit['redirect'] }[] = [];
      const fetchFn = async (url: string, init?: RequestInit) => {
        seen.push({ url, redirect: init?.redirect });
        const route = map[url];
        return route ? route() : new Response('nope', { status: 404 });
      };
      return { fetchFn, seen };
    }
    const redirect = (to: string) => () =>
      new Response(null, { status: 302, headers: { Location: to } });

    test('a url on another host is refused without a request', async () => {
      const { fetchFn, seen } = routes({});
      const embedder = await createTransformersEmbedder(
        { model: 'm', cacheDir: 'c' },
        { fetchFn, loadPipeline: load }
      );
      await expect(embedder.embed('https://evil.example/a.jpg')).rejects.toThrow(/not allowed/);
      await expect(embedder.embed('http://i.ebayimg.com/a.jpg')).rejects.toThrow(/not allowed/);
      expect(seen).toHaveLength(0);
    });

    test('a redirect to an allowed host is followed, manually', async () => {
      const { fetchFn, seen } = routes({
        'https://www.blue-ocean.de/a.jpg': redirect('https://cdn.blue-ocean.de/a.jpg'),
        'https://cdn.blue-ocean.de/a.jpg': () => new Response(new Uint8Array([1])),
      });
      const embedder = await createTransformersEmbedder(
        { model: 'm', cacheDir: 'c' },
        { fetchFn, loadPipeline: load }
      );
      expect(Array.from(await embedder.embed('https://www.blue-ocean.de/a.jpg'))).toEqual([1, 0]);
      expect(seen).toEqual([
        { url: 'https://www.blue-ocean.de/a.jpg', redirect: 'manual' },
        { url: 'https://cdn.blue-ocean.de/a.jpg', redirect: 'manual' },
      ]);
    });

    test('a relative redirect resolves against the current url', async () => {
      const { fetchFn } = routes({
        'https://i.ebayimg.com/a.jpg': redirect('/b.jpg'),
        'https://i.ebayimg.com/b.jpg': () => new Response(new Uint8Array([1])),
      });
      const embedder = await createTransformersEmbedder(
        { model: 'm', cacheDir: 'c' },
        { fetchFn, loadPipeline: load }
      );
      expect(Array.from(await embedder.embed('https://i.ebayimg.com/a.jpg'))).toEqual([1, 0]);
    });

    test('a redirect to another host is refused', async () => {
      const { fetchFn, seen } = routes({
        'https://i.ebayimg.com/a.jpg': redirect('https://169.254.169.254/latest/meta-data'),
      });
      const embedder = await createTransformersEmbedder(
        { model: 'm', cacheDir: 'c' },
        { fetchFn, loadPipeline: load }
      );
      await expect(embedder.embed('https://i.ebayimg.com/a.jpg')).rejects.toThrow(/not allowed/);
      expect(seen).toHaveLength(1);
    });

    test('more than 3 redirects is refused', async () => {
      const { fetchFn, seen } = routes({
        'https://i.ebayimg.com/0.jpg': redirect('https://i.ebayimg.com/1.jpg'),
        'https://i.ebayimg.com/1.jpg': redirect('https://i.ebayimg.com/2.jpg'),
        'https://i.ebayimg.com/2.jpg': redirect('https://i.ebayimg.com/3.jpg'),
        'https://i.ebayimg.com/3.jpg': redirect('https://i.ebayimg.com/4.jpg'),
        'https://i.ebayimg.com/4.jpg': () => new Response(new Uint8Array([1])),
      });
      const embedder = await createTransformersEmbedder(
        { model: 'm', cacheDir: 'c' },
        { fetchFn, loadPipeline: load }
      );
      await expect(embedder.embed('https://i.ebayimg.com/0.jpg')).rejects.toThrow(/redirects/);
      expect(seen).toHaveLength(4);
    });

    test('a refused host is image_unavailable in matchListing', async () => {
      const { fetchFn } = routes({});
      const embedder = await createTransformersEmbedder(
        { model: 'm', cacheDir: 'c' },
        { fetchFn, loadPipeline: load }
      );
      const reasons: string[] = [];
      expect(
        await matchListing(
          { ...blue12, imageUrl: 'https://evil.example/a.jpg' },
          IMG,
          embedder,
          0.85,
          { onUnavailable: (_status, r) => reasons.push(r) }
        )
      ).toEqual({ status: 'image_unavailable', similarity: null, picture: null });
      expect(reasons[0]).toContain('not allowed');
    });
  });

  test('a model that cannot load rejects', async () => {
    await expect(
      createTransformersEmbedder(
        { model: 'm', cacheDir: 'c' },
        {
          loadPipeline: async () => {
            throw new Error('offline');
          },
        }
      )
    ).rejects.toThrow(/offline/);
  });
});

describe('pooledOutput', () => {
  const t = (n: number) => ({ data: new Float32Array([n]), dims: [1, 1] });

  test('prefers pooler_output, then image_embeds, then last_hidden_state', () => {
    expect(
      pooledOutput({ pooler_output: t(1), image_embeds: t(2), last_hidden_state: t(3) })
    ).toEqual(t(1));
    expect(pooledOutput({ image_embeds: t(2), last_hidden_state: t(3) })).toEqual(t(2));
    expect(pooledOutput({ last_hidden_state: t(3) })).toEqual(t(3));
  });

  test('throws and names the outputs it got when none fits', () => {
    expect(() => pooledOutput({ logits: t(1) })).toThrow(/logits/);
  });
});
