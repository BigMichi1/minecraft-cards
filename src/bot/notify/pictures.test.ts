import { describe, expect, spyOn, test } from 'bun:test';
import { EmbedBuilder, type APIEmbed, type MessageCreateOptions } from 'discord.js';
import { downloadImage, MAX_IMAGE_BYTES } from '../matcher/embedder';
import type { FetchFn } from '../shops/types';
import logger from '../utils/logger';
import {
  attachPictures,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_PICTURE_BYTES,
  PictureRun,
  pictureExtension,
  type DownloadFn,
} from './pictures';

/** One message through a fresh run, as the sender does once per send(). */
function attach(msg: MessageCreateOptions, download: DownloadFn): Promise<MessageCreateOptions> {
  return attachPictures(msg, new PictureRun(download));
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const COLLECT_IT =
  'https://www.collect-it.de/media/image/product/623998/md/14-alex-charakterkarte-lava-serie-3.jpg';
const REFERENCE = 'https://shop-sammel-ente.de/media/12.png';

function embed(image?: string, thumbnail?: string): EmbedBuilder {
  const e = new EmbedBuilder().setTitle('t');
  if (image) e.setImage(image);
  if (thumbnail) e.setThumbnail(thumbnail);
  return e;
}

function embeds(msg: MessageCreateOptions): APIEmbed[] {
  return (msg.embeds ?? []).map((e) =>
    'toJSON' in e && typeof e.toJSON === 'function' ? e.toJSON() : (e as APIEmbed)
  );
}

interface FileLike {
  attachment: Buffer;
  name: string;
}
function files(msg: MessageCreateOptions): FileLike[] {
  return (msg.files ?? []) as FileLike[];
}

function downloader(byUrl: Record<string, Uint8Array | Error>) {
  const calls: string[] = [];
  const caps: number[] = [];
  const download = async (url: string, maxBytes: number) => {
    calls.push(url);
    caps.push(maxBytes);
    const v = byUrl[url];
    if (v === undefined) throw new Error(`unexpected download ${url}`);
    if (v instanceof Error) throw v;
    return v;
  };
  return { download, calls, caps };
}

const text = (s: string) => new TextEncoder().encode(s);

describe('pictureExtension', () => {
  test('recognises JPEG, PNG, GIF and WebP, nothing else', () => {
    expect(pictureExtension(JPEG)).toBe('jpg');
    expect(pictureExtension(PNG)).toBe('png');
    expect(pictureExtension(text('GIF89a...'))).toBe('gif');
    expect(pictureExtension(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(pictureExtension(text('<html>'))).toBeNull();
    expect(pictureExtension(new Uint8Array())).toBeNull();
  });
});

describe('attachPictures', () => {
  test('a downloaded picture is attached and the embed uses attachment://', async () => {
    const { download, calls, caps } = downloader({ [COLLECT_IT]: JPEG });
    const msg = await attach({ embeds: [embed(COLLECT_IT)], components: [] }, download);
    expect(calls).toEqual([COLLECT_IT]);
    expect(caps).toEqual([MAX_PICTURE_BYTES]);
    expect(files(msg).map((f) => f.name)).toEqual(['picture-1.jpg']);
    expect(Array.from(files(msg)[0]!.attachment)).toEqual(Array.from(JPEG));
    expect(embeds(msg)[0]?.image?.url).toBe('attachment://picture-1.jpg');
    expect(embeds(msg)[0]?.title).toBe('t');
    expect(msg.components).toEqual([]);
  });

  test('the reference thumbnail is attached too', async () => {
    const { download } = downloader({ [COLLECT_IT]: JPEG, [REFERENCE]: PNG });
    const msg = await attach({ embeds: [embed(COLLECT_IT, REFERENCE)] }, download);
    expect(files(msg).map((f) => f.name)).toEqual(['picture-1.jpg', 'reference-1.png']);
    expect(embeds(msg)[0]?.thumbnail?.url).toBe('attachment://reference-1.png');
  });

  test('a failed download falls back to the URL', async () => {
    const { download } = downloader({ [COLLECT_IT]: new Error('403 Forbidden') });
    const msg = await attach({ embeds: [embed(COLLECT_IT)] }, download);
    expect(files(msg)).toEqual([]);
    expect(embeds(msg)[0]?.image?.url).toBe(COLLECT_IT);
  });

  test('a download that is not a picture falls back to the URL', async () => {
    const { download } = downloader({ [COLLECT_IT]: text('<html>') });
    const msg = await attach({ embeds: [embed(COLLECT_IT)] }, download);
    expect(files(msg)).toEqual([]);
    expect(embeds(msg)[0]?.image?.url).toBe(COLLECT_IT);
  });

  test('a disallowed host is not downloaded', async () => {
    const other = 'https://evil.example/1.jpg';
    const plainHttp = 'http://shop-sammel-ente.de/x.png';
    const { download, calls } = downloader({});
    const msg = await attach({ embeds: [embed(other, plainHttp)] }, download);
    expect(calls).toEqual([]);
    expect(files(msg)).toEqual([]);
    expect(embeds(msg)[0]?.image?.url).toBe(other);
    expect(embeds(msg)[0]?.thumbnail?.url).toBe(plainHttp);
  });

  test('several listings in one message get unique names; a shared URL is downloaded once', async () => {
    const urls = [1, 2, 3, 4, 5].map((n) => `https://i.ebayimg.com/${n}.jpg`);
    const { download, calls } = downloader({
      ...Object.fromEntries(urls.map((u) => [u, JPEG])),
      [REFERENCE]: PNG,
    });
    const msg = await attach({ embeds: urls.map((u) => embed(u, REFERENCE)) }, download);
    const names = files(msg).map((f) => f.name);
    expect(names).toHaveLength(MAX_ATTACHMENTS);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+-\d+\.(jpg|png)$/);
    embeds(msg).forEach((e, i) => {
      expect(e.image?.url).toBe(`attachment://picture-${i + 1}.jpg`);
      expect(e.thumbnail?.url).toBe(`attachment://reference-${i + 1}.png`);
    });
    expect(calls.filter((c) => c === REFERENCE)).toHaveLength(1);
  });

  test('never attaches more than 10 files; the rest keep their URL', async () => {
    const urls = Array.from({ length: 6 }, (_, n) => `https://i.ebayimg.com/${n}.jpg`);
    const { download } = downloader({
      ...Object.fromEntries(urls.map((u) => [u, JPEG])),
      [REFERENCE]: PNG,
    });
    const msg = await attach({ embeds: urls.map((u) => embed(u, REFERENCE)) }, download);
    expect(files(msg)).toHaveLength(MAX_ATTACHMENTS);
    expect(embeds(msg)[5]?.image?.url).toBe(urls[5]);
    expect(embeds(msg)[5]?.thumbnail?.url).toBe(REFERENCE);
  });

  test('pictures past the byte budget of a message keep their URL', async () => {
    const big = new Uint8Array(Math.floor(MAX_ATTACHMENT_BYTES / 2) + 1);
    big.set(JPEG);
    const urls = ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/b.jpg'];
    const { download } = downloader({ [urls[0]!]: big, [urls[1]!]: big });
    const msg = await attach({ embeds: urls.map((u) => embed(u)) }, download);
    expect(files(msg).map((f) => f.name)).toEqual(['picture-1.jpg']);
    expect(embeds(msg)[1]?.image?.url).toBe(urls[1]);
  });

  test('keeps files already on the message and counts them against the limit', async () => {
    const existing = { attachment: Buffer.from('x'), name: 'other.txt' };
    const { download } = downloader({ [COLLECT_IT]: JPEG });
    const msg = await attach({ embeds: [embed(COLLECT_IT)], files: [existing] }, download);
    expect(files(msg).map((f) => f.name)).toEqual(['other.txt', 'picture-1.jpg']);
  });

  test('an unexpected error returns the message as built', async () => {
    const broken = {
      toJSON: () => {
        throw new Error('bad embed');
      },
    };
    const msg = { embeds: [broken] } as unknown as MessageCreateOptions;
    const { download } = downloader({});
    expect(await attach(msg, download)).toBe(msg);
  });

  test('a message without pictures to attach is returned unchanged', async () => {
    const { download, calls } = downloader({});
    const msg = { content: 'hi', embeds: [embed()] };
    expect(await attach(msg, download)).toBe(msg);
    expect(calls).toEqual([]);
  });

  test('downloads of one message run in parallel and keep their order', async () => {
    const started: string[] = [];
    const resolvers = new Map<string, (b: Uint8Array) => void>();
    const download = (url: string) => {
      started.push(url);
      return new Promise<Uint8Array>((resolve) => resolvers.set(url, resolve));
    };
    const urls = ['https://i.ebayimg.com/1.jpg', 'https://i.ebayimg.com/2.jpg'];
    const pending = attach({ embeds: urls.map((u) => embed(u, REFERENCE)) }, download);
    await Promise.resolve();
    await Promise.resolve();
    expect(started.sort()).toEqual([...urls, REFERENCE].sort());
    resolvers.get(urls[1]!)!(PNG);
    resolvers.get(REFERENCE)!(PNG);
    resolvers.get(urls[0]!)!(JPEG);
    const msg = await pending;
    expect(files(msg).map((f) => f.name)).toEqual([
      'picture-1.jpg',
      'reference-1.png',
      'picture-2.png',
      'reference-2.png',
    ]);
  });

  test('one run downloads a shared picture once across messages', async () => {
    const { download, calls } = downloader({ [REFERENCE]: PNG, [COLLECT_IT]: JPEG });
    const run = new PictureRun(download);
    const a = await attachPictures({ embeds: [embed(COLLECT_IT, REFERENCE)] }, run);
    const b = await attachPictures({ embeds: [embed(undefined, REFERENCE)] }, run);
    expect(calls).toEqual([COLLECT_IT, REFERENCE]);
    expect(files(a).map((f) => f.name)).toEqual(['picture-1.jpg', 'reference-1.png']);
    expect(files(b).map((f) => f.name)).toEqual(['reference-1.png']);
  });

  describe('warnings once per run and reason', () => {
    function warnings(run: () => Promise<unknown>) {
      const warn = spyOn(logger, 'warn');
      return run()
        .then(() => warn.mock.calls.map((c) => String(c[0])))
        .finally(() => warn.mockRestore());
    }

    test('a host that is not allowed', async () => {
      const { download } = downloader({});
      const run = new PictureRun(download);
      const texts = await warnings(async () => {
        await attachPictures({ embeds: [embed('https://evil.example/1.jpg')] }, run);
        await attachPictures({ embeds: [embed('https://evil.example/2.jpg')] }, run);
      });
      expect(texts.filter((t) => t.includes('host not allowed'))).toHaveLength(1);
    });

    test('the attachment limit', async () => {
      const urls = Array.from({ length: 6 }, (_, n) => `https://i.ebayimg.com/${n}.jpg`);
      const { download } = downloader({
        ...Object.fromEntries(urls.map((u) => [u, JPEG])),
        [REFERENCE]: PNG,
      });
      const run = new PictureRun(download);
      const texts = await warnings(async () => {
        await attachPictures({ embeds: urls.map((u) => embed(u, REFERENCE)) }, run);
        await attachPictures({ embeds: urls.map((u) => embed(u, REFERENCE)) }, run);
      });
      expect(texts.filter((t) => t.includes('attachment limit'))).toHaveLength(1);
    });

    test('the byte budget', async () => {
      const big = new Uint8Array(Math.floor(MAX_ATTACHMENT_BYTES / 2) + 1);
      big.set(JPEG);
      const urls = ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/b.jpg'];
      const { download } = downloader({ [urls[0]!]: big, [urls[1]!]: big });
      const run = new PictureRun(download);
      const texts = await warnings(async () => {
        await attachPictures({ embeds: urls.map((u) => embed(u)) }, run);
        await attachPictures({ embeds: urls.map((u) => embed(u)) }, run);
      });
      expect(texts.filter((t) => t.includes('byte budget'))).toHaveLength(1);
    });
  });

  describe('PictureRun.alertText', () => {
    const ok = (n: number) => `https://i.ebayimg.com/${n}.jpg`;

    test('is null when every picture was attached or none was tried', async () => {
      const { download } = downloader({ [ok(1)]: JPEG });
      const run = new PictureRun(download);
      expect(run.alertText()).toBeNull();
      await attachPictures({ embeds: [embed(ok(1))] }, run);
      expect(run.alertText()).toBeNull();
    });

    test('names a host whose every picture fell back, with the reason', async () => {
      const { download } = downloader({
        [ok(1)]: JPEG,
        [ok(2)]: JPEG,
        [ok(3)]: JPEG,
        [COLLECT_IT]: new Error('HTTP 403'),
      });
      const run = new PictureRun(download);
      await attachPictures({ embeds: [ok(1), ok(2), ok(3), COLLECT_IT].map((u) => embed(u)) }, run);
      const text = run.alertText();
      expect(text).toContain('www.collect-it.de 1 of 1');
      expect(text).toContain('HTTP 403');
      expect(text).not.toContain('i.ebayimg.com');
    });

    test('fires when more than half of the pictures fell back', async () => {
      const { download } = downloader({
        [ok(1)]: JPEG,
        [ok(2)]: new Error('timeout'),
        [ok(3)]: text('<html>'),
      });
      const run = new PictureRun(download);
      await attachPictures({ embeds: [ok(1), ok(2), ok(3)].map((u) => embed(u)) }, run);
      const t = run.alertText();
      expect(t).toContain('i.ebayimg.com 2 of 3');
      expect(t).toContain('timeout');
      expect(t).toContain('not a JPEG, PNG, GIF or WebP');
    });

    test('stays quiet for a minority of failures on a host that mostly works', async () => {
      const { download } = downloader({
        [ok(1)]: JPEG,
        [ok(2)]: JPEG,
        [ok(3)]: new Error('reset'),
      });
      const run = new PictureRun(download);
      await attachPictures({ embeds: [ok(1), ok(2), ok(3)].map((u) => embed(u)) }, run);
      expect(run.alertText()).toBeNull();
    });

    test('a host that is not allowed counts; attachment limit and byte budget do not', async () => {
      const urls = Array.from({ length: 6 }, (_, n) => ok(n));
      const { download } = downloader({
        ...Object.fromEntries(urls.map((u) => [u, JPEG])),
        [REFERENCE]: PNG,
      });
      const run = new PictureRun(download);
      await attachPictures({ embeds: urls.map((u) => embed(u, REFERENCE)) }, run);
      expect(run.alertText()).toBeNull();
      await attachPictures({ embeds: [embed('https://evil.example/1.jpg')] }, run);
      expect(run.alertText()).toContain('evil.example 1 of 1 (host not allowed)');
    });
  });

  describe('with the bounded matcher download', () => {
    test('a 9 MB picture is refused early by the notification cap and falls back', async () => {
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(512 * 1024));
          if (pulled >= 18) controller.close();
        },
      });
      const fetchFn: FetchFn = async () => new Response(stream);
      const msg = await attach({ embeds: [embed(COLLECT_IT)] }, (url, max) =>
        downloadImage(url, fetchFn, max)
      );
      expect(files(msg)).toEqual([]);
      expect(embeds(msg)[0]?.image?.url).toBe(COLLECT_IT);
      expect(pulled).toBeLessThan(10);
    });

    test('a declared 9 MB picture is refused before reading', async () => {
      const fetchFn: FetchFn = async () =>
        new Response(JPEG, { headers: { 'Content-Length': String(9 * 1024 * 1024) } });
      const msg = await attach({ embeds: [embed(COLLECT_IT)] }, (url, max) =>
        downloadImage(url, fetchFn, max)
      );
      expect(files(msg)).toEqual([]);
      expect(MAX_PICTURE_BYTES).toBe(2 * 1024 * 1024);
    });

    test('a picture over the size limit falls back to the URL', async () => {
      const fetchFn: FetchFn = async () =>
        new Response(JPEG, { headers: { 'Content-Length': String(MAX_IMAGE_BYTES + 1) } });
      const msg = await attach({ embeds: [embed(COLLECT_IT)] }, (url, max) =>
        downloadImage(url, fetchFn, max)
      );
      expect(files(msg)).toEqual([]);
      expect(embeds(msg)[0]?.image?.url).toBe(COLLECT_IT);
    });

    test('a timeout falls back to the URL', async () => {
      const fetchFn: FetchFn = async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      };
      const msg = await attach({ embeds: [embed(COLLECT_IT)] }, (url, max) =>
        downloadImage(url, fetchFn, max)
      );
      expect(files(msg)).toEqual([]);
      expect(embeds(msg)[0]?.image?.url).toBe(COLLECT_IT);
    });

    test('an HTTP error falls back to the URL', async () => {
      const fetchFn: FetchFn = async () => new Response('no', { status: 403 });
      const msg = await attach({ embeds: [embed(COLLECT_IT)] }, (url, max) =>
        downloadImage(url, fetchFn, max)
      );
      expect(files(msg)).toEqual([]);
      expect(embeds(msg)[0]?.image?.url).toBe(COLLECT_IT);
    });

    test('a picture under the limit is attached, fetched with the bot user agent', async () => {
      const agents: (string | null)[] = [];
      const fetchFn: FetchFn = async (_url, init) => {
        agents.push(new Headers(init?.headers).get('User-Agent'));
        return new Response(JPEG);
      };
      const msg = await attach({ embeds: [embed(COLLECT_IT)] }, (url, max) =>
        downloadImage(url, fetchFn, max)
      );
      expect(files(msg).map((f) => f.name)).toEqual(['picture-1.jpg']);
      expect(agents).toEqual(['minecraft-cards-bot/1.0 (+hourly stock check)']);
    });
  });
});
