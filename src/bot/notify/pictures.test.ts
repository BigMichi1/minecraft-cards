import { describe, expect, test } from 'bun:test';
import { EmbedBuilder, type APIEmbed, type MessageCreateOptions } from 'discord.js';
import { downloadImage, MAX_IMAGE_BYTES } from '../matcher/embedder';
import type { FetchFn } from '../shops/types';
import {
  attachPictures,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  pictureExtension,
} from './pictures';

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
  const download = async (url: string) => {
    calls.push(url);
    const v = byUrl[url];
    if (v === undefined) throw new Error(`unexpected download ${url}`);
    if (v instanceof Error) throw v;
    return v;
  };
  return { download, calls };
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
    const { download, calls } = downloader({ [COLLECT_IT]: JPEG });
    const msg = await attachPictures({ embeds: [embed(COLLECT_IT)], components: [] }, download);
    expect(calls).toEqual([COLLECT_IT]);
    expect(files(msg).map((f) => f.name)).toEqual(['picture-1.jpg']);
    expect(Array.from(files(msg)[0]!.attachment)).toEqual(Array.from(JPEG));
    expect(embeds(msg)[0]?.image?.url).toBe('attachment://picture-1.jpg');
    expect(embeds(msg)[0]?.title).toBe('t');
    expect(msg.components).toEqual([]);
  });

  test('the reference thumbnail is attached too', async () => {
    const { download } = downloader({ [COLLECT_IT]: JPEG, [REFERENCE]: PNG });
    const msg = await attachPictures({ embeds: [embed(COLLECT_IT, REFERENCE)] }, download);
    expect(files(msg).map((f) => f.name)).toEqual(['picture-1.jpg', 'reference-1.png']);
    expect(embeds(msg)[0]?.thumbnail?.url).toBe('attachment://reference-1.png');
  });

  test('a failed download falls back to the URL', async () => {
    const { download } = downloader({ [COLLECT_IT]: new Error('403 Forbidden') });
    const msg = await attachPictures({ embeds: [embed(COLLECT_IT)] }, download);
    expect(files(msg)).toEqual([]);
    expect(embeds(msg)[0]?.image?.url).toBe(COLLECT_IT);
  });

  test('a download that is not a picture falls back to the URL', async () => {
    const { download } = downloader({ [COLLECT_IT]: text('<html>') });
    const msg = await attachPictures({ embeds: [embed(COLLECT_IT)] }, download);
    expect(files(msg)).toEqual([]);
    expect(embeds(msg)[0]?.image?.url).toBe(COLLECT_IT);
  });

  test('a disallowed host is not downloaded', async () => {
    const other = 'https://evil.example/1.jpg';
    const plainHttp = 'http://shop-sammel-ente.de/x.png';
    const { download, calls } = downloader({});
    const msg = await attachPictures({ embeds: [embed(other, plainHttp)] }, download);
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
    const msg = await attachPictures({ embeds: urls.map((u) => embed(u, REFERENCE)) }, download);
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
    const msg = await attachPictures({ embeds: urls.map((u) => embed(u, REFERENCE)) }, download);
    expect(files(msg)).toHaveLength(MAX_ATTACHMENTS);
    expect(embeds(msg)[5]?.image?.url).toBe(urls[5]);
    expect(embeds(msg)[5]?.thumbnail?.url).toBe(REFERENCE);
  });

  test('pictures past the byte budget of a message keep their URL', async () => {
    const big = new Uint8Array(Math.floor(MAX_ATTACHMENT_BYTES / 2) + 1);
    big.set(JPEG);
    const urls = ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/b.jpg'];
    const { download } = downloader({ [urls[0]!]: big, [urls[1]!]: big });
    const msg = await attachPictures({ embeds: urls.map((u) => embed(u)) }, download);
    expect(files(msg).map((f) => f.name)).toEqual(['picture-1.jpg']);
    expect(embeds(msg)[1]?.image?.url).toBe(urls[1]);
  });

  test('keeps files already on the message and counts them against the limit', async () => {
    const existing = { attachment: Buffer.from('x'), name: 'other.txt' };
    const { download } = downloader({ [COLLECT_IT]: JPEG });
    const msg = await attachPictures({ embeds: [embed(COLLECT_IT)], files: [existing] }, download);
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
    expect(await attachPictures(msg, download)).toBe(msg);
  });

  test('a message without pictures to attach is returned unchanged', async () => {
    const { download, calls } = downloader({});
    const msg = { content: 'hi', embeds: [embed()] };
    expect(await attachPictures(msg, download)).toBe(msg);
    expect(calls).toEqual([]);
  });

  describe('with the bounded matcher download', () => {
    test('a picture over the size limit falls back to the URL', async () => {
      const fetchFn: FetchFn = async () =>
        new Response(JPEG, { headers: { 'Content-Length': String(MAX_IMAGE_BYTES + 1) } });
      const msg = await attachPictures({ embeds: [embed(COLLECT_IT)] }, (url) =>
        downloadImage(url, fetchFn)
      );
      expect(files(msg)).toEqual([]);
      expect(embeds(msg)[0]?.image?.url).toBe(COLLECT_IT);
    });

    test('a timeout falls back to the URL', async () => {
      const fetchFn: FetchFn = async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      };
      const msg = await attachPictures({ embeds: [embed(COLLECT_IT)] }, (url) =>
        downloadImage(url, fetchFn)
      );
      expect(files(msg)).toEqual([]);
      expect(embeds(msg)[0]?.image?.url).toBe(COLLECT_IT);
    });

    test('an HTTP error falls back to the URL', async () => {
      const fetchFn: FetchFn = async () => new Response('no', { status: 403 });
      const msg = await attachPictures({ embeds: [embed(COLLECT_IT)] }, (url) =>
        downloadImage(url, fetchFn)
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
      const msg = await attachPictures({ embeds: [embed(COLLECT_IT)] }, (url) =>
        downloadImage(url, fetchFn)
      );
      expect(files(msg).map((f) => f.name)).toEqual(['picture-1.jpg']);
      expect(agents).toEqual(['minecraft-cards-bot/1.0 (+hourly stock check)']);
    });
  });
});
