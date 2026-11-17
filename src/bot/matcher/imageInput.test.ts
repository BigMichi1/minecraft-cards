import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { centerCrop, decodePng, prepareImage, resizedSize, type Pixels } from './imageInput';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Build a PNG from already-filtered scanlines (each row starts with its filter byte). */
function png(
  width: number,
  height: number,
  colorType: number,
  rows: number[][],
  opts: { depth?: number; interlace?: number } = {}
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = opts.depth ?? 8;
  ihdr[9] = colorType;
  ihdr[12] = opts.interlace ?? 0;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(rows.flat())))),
    chunk('IEND', new Uint8Array()),
  ];
  return new Uint8Array(Buffer.concat(parts));
}

describe('decodePng', () => {
  test('undoes every scanline filter (RGB)', () => {
    // 2x5 RGB; rows use filters none, sub, up, average, paeth.
    const bytes = png(2, 5, 2, [
      [0, 10, 20, 30, 40, 50, 60],
      [1, 1, 2, 3, 4, 4, 4], // sub: [1,2,3] then [5,6,7]
      [2, 1, 1, 1, 1, 1, 1], // up: row1 + 1
      [3, 0, 0, 0, 0, 0, 0], // average of left and up
      [4, 0, 0, 0, 0, 0, 0], // paeth
    ]);
    const img = decodePng(bytes);
    expect({ w: img.width, h: img.height, c: img.channels }).toEqual({ w: 2, h: 5, c: 3 });
    expect(Array.from(img.data)).toEqual([
      10, 20, 30, 40, 50, 60, 1, 2, 3, 5, 6, 7, 2, 3, 4, 6, 7, 8, 1, 1, 2, 3, 4, 5, 1, 1, 2, 3, 4,
      5,
    ]);
  });

  test('reads RGBA and grey images', () => {
    expect(decodePng(png(1, 1, 6, [[0, 1, 2, 3, 4]])).channels).toBe(4);
    expect(Array.from(decodePng(png(2, 1, 0, [[0, 7, 9]])).data)).toEqual([7, 9]);
  });

  test('rejects what it cannot read', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);
    expect(() => decodePng(png(1, 1, 2, [[0, 1, 2, 3]], { depth: 16 }))).toThrow(/unsupported/);
    expect(() => decodePng(png(1, 1, 2, [[0, 1, 2, 3]], { interlace: 1 }))).toThrow(/unsupported/);
    expect(() => decodePng(png(1, 1, 3, [[0, 1]]))).toThrow(/unsupported/);
    expect(() => decodePng(png(1, 1, 2, [[9, 1, 2, 3]]))).toThrow(/filter 9/);
    expect(() => decodePng(png(1, 2, 2, [[0, 1, 2, 3]]))).toThrow(/truncated/);
  });
});

describe('resizedSize', () => {
  test('scales the shortest edge like transformers.js', () => {
    expect(resizedSize(400, 568, { size: { shortest_edge: 256 } })).toEqual([256, 363]);
    expect(resizedSize(568, 400, { size: { shortest_edge: 224 } })).toEqual([318, 224]);
  });

  test('uses fixed width and height, else keeps the size', () => {
    expect(resizedSize(400, 568, { size: { width: 224, height: 224 } })).toEqual([224, 224]);
    expect(resizedSize(400, 568, {})).toEqual([400, 568]);
  });
});

describe('centerCrop', () => {
  const grid: Pixels = {
    data: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    width: 4,
    height: 4,
    channels: 1,
  };

  test('keeps the middle', () => {
    expect(Array.from(centerCrop(grid, 2, 2).data)).toEqual([6, 7, 10, 11]);
    expect(centerCrop(grid, 4, 4)).toBe(grid);
  });

  test('pads a too small image with black', () => {
    const out = centerCrop(
      { ...grid, data: new Uint8ClampedArray([5]), width: 1, height: 1 },
      3,
      1
    );
    expect(Array.from(out.data)).toEqual([0, 5, 0]);
  });
});

describe('prepareImage', () => {
  // 4x2 RGB, left half black, right half white.
  const source = png(4, 2, 2, [
    [0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255],
    [0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255],
  ]);

  test('resizes the shortest edge and center-crops', async () => {
    const out = await prepareImage(source, {
      do_resize: true,
      do_center_crop: true,
      size: { shortest_edge: 4 },
      crop_size: { width: 4, height: 4 },
      resample: 0,
    });
    expect({ w: out.width, h: out.height }).toEqual({ w: 4, h: 4 });
    const red = (x: number, y: number): number => out.data[(y * 4 + x) * out.channels]!;
    // 8x4 after resize, middle 4 columns: two black then two white
    expect([red(0, 0), red(1, 0), red(2, 3), red(3, 3)]).toEqual([0, 0, 255, 255]);
  });

  test('skips resize and crop when the processor does', async () => {
    const out = await prepareImage(source, {
      do_resize: false,
      do_center_crop: false,
      size: { shortest_edge: 100 },
      crop_size: 1,
    });
    expect({ w: out.width, h: out.height }).toEqual({ w: 4, h: 2 });
  });

  test('a square crop size works too', async () => {
    const out = await prepareImage(source, { do_center_crop: true, crop_size: 2 });
    expect({ w: out.width, h: out.height }).toEqual({ w: 2, h: 2 });
  });
});
