import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { db, initializeDatabase } from '../database/db';
import { imageEmbeddings } from '../database/schema/index';
import type { Listing } from '../shops/types';
import {
  allowedImageUrl,
  createCachedEmbedder,
  createTransformersEmbedder,
  DEFAULT_IMAGE_MATCH_THRESHOLD,
  DEFAULT_IMAGE_MODEL,
  matchListing,
  MAX_IMAGE_BYTES,
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

  test('onUnavailable receives the reason instead of a per-listing log line', async () => {
    const reasons: string[] = [];
    const onUnavailable = (reason: string) => reasons.push(reason);
    await matchListing(blue12, 'ref12', null, 0.85, { onUnavailable });
    await matchListing(blue12, 'ref12', throwingEmbedder, 0.85, { onUnavailable });
    await matchListing(blue12, 'ref12', fakeSame, 0.85, { onUnavailable });
    expect(reasons).toEqual(['no image model loaded', 'broken: onnx runtime missing']);
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

const IMG = 'https://shop-sammel-ente.de/media/12.jpg';

describe('allowedImageUrl', () => {
  test('only https on the shop and eBay image hosts', () => {
    for (const ok of [
      'https://shop-sammel-ente.de/media/a.jpg',
      'https://cdn.blue-ocean.de/a.jpg',
      'https://www.blue-ocean.de/a.jpg',
      'https://i.ebayimg.com/images/g/a/s-l225.jpg',
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
    await expect(embedder.embed('https://cdn.blue-ocean.de/missing.jpg')).rejects.toThrow(/404/);
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

    test('an oversize picture is model_unavailable in matchListing', async () => {
      const embedder = await createTransformersEmbedder(
        { model: 'm', cacheDir: 'c' },
        {
          fetchFn: async () =>
            new Response('x', { headers: { 'Content-Length': String(MAX_IMAGE_BYTES * 2) } }),
          loadPipeline: load,
        }
      );
      expect(await matchListing({ ...blue12, imageUrl: IMG }, IMG, embedder, 0.85)).toEqual({
        status: 'model_unavailable',
        similarity: null,
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

    test('a refused host is model_unavailable in matchListing', async () => {
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
          { onUnavailable: (r) => reasons.push(r) }
        )
      ).toEqual({ status: 'model_unavailable', similarity: null });
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
