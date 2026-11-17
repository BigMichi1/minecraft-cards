import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { db, initializeDatabase } from '../database/db';
import { imageEmbeddings } from '../database/schema/index';
import type { Listing } from '../shops/types';
import {
  createCachedEmbedder,
  createTransformersEmbedder,
  DEFAULT_IMAGE_MATCH_THRESHOLD,
  DEFAULT_IMAGE_MODEL,
  matchListing,
  pooledOutput,
  type ImageEmbedder,
} from './embedder';

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
    throw new Error('onnx runtime missing');
  },
};

const blue12: Listing = {
  shop: 'blue-ocean',
  url: 'https://www.blue-ocean.de/nr.-9-squid-2dd00088-12',
  title: 'Nr. 9 Squid LEGO Minecraft TCC',
  cardIds: ['12'],
  cardName: null,
  imageUrl: 'img12',
  price: { cents: 80, currency: 'EUR' },
  available: true,
  format: 'shop',
  auctionEndsAt: null,
  idConflict: false,
};
const bundle: Listing = { ...blue12, shop: 'ebay', cardIds: ['12', '13'], format: 'fixed_price' };

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
    expect(result).toEqual({ status: 'confirmed', similarity: expect.closeTo(1, 5) });
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
    });
    expect((await matchListing(blue12, 'ref12', null, 0.85)).status).toBe('model_unavailable');
  });

  test('bundles, sammel-ente and missing references skip the comparison', async () => {
    const counting = fakeEmbedder({});
    expect((await matchListing(bundle, 'ref12', counting, 0.85)).status).toBe('bundle');
    expect(
      (await matchListing({ ...blue12, shop: 'sammel-ente' }, null, counting, 0.85)).status
    ).toBe('reference');
    expect(await matchListing(blue12, null, counting, 0.85)).toEqual({
      status: 'no_reference',
      similarity: null,
    });
    expect(counting.calls).toBe(0);
  });

  test('a listing without a picture stays unconfirmed', async () => {
    expect(await matchListing({ ...blue12, imageUrl: null }, 'ref12', fakeSame, 0.85)).toEqual({
      status: 'unconfirmed',
      similarity: null,
    });
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
    const vec = await embedder.embed('https://img/1.jpg');
    expect(Array.from(vec).map((v) => Number(v.toFixed(5)))).toEqual([0.6, 0.8]);
    expect(seen).toEqual([
      {
        url: 'https://img/1.jpg',
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
    expect(Array.from(await embedder.embed('u'))).toEqual([0, 1]);
  });

  test('a zero vector stays zero instead of becoming NaN', async () => {
    const embedder = await createTransformersEmbedder(
      { model: 'm', cacheDir: 'c' },
      {
        fetchFn: okFetch,
        loadPipeline: async () => async () => ({ data: new Float32Array([0, 0]), dims: [1, 2] }),
      }
    );
    expect(Array.from(await embedder.embed('u'))).toEqual([0, 0]);
  });

  test('a failed image download throws with the status', async () => {
    const embedder = await createTransformersEmbedder(
      { model: 'm', cacheDir: 'c' },
      {
        fetchFn: async () => new Response('nope', { status: 404 }),
        loadPipeline: async () => async () => ({ data: new Float32Array([1]), dims: [1, 1] }),
      }
    );
    await expect(embedder.embed('https://img/missing.jpg')).rejects.toThrow(/404/);
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
