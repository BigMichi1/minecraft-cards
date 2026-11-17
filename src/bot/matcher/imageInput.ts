/**
 * Turns an encoded picture into the pixels an image model expects, without `sharp`.
 *
 * transformers.js decodes, resizes and crops with `sharp` under Bun, and every `sharp`
 * operation hangs on Bun 1.4.4 (the promise never settles; see docs/image-matching.md).
 * Bun's own `Bun.Image` decodes and resizes instead; it only re-encodes, so the resized
 * picture goes through PNG and a small decoder here, then gets center-cropped in JS.
 */
import { inflateSync } from 'node:zlib';

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

/** The resize and crop settings of a transformers.js image processor. */
export interface ResizeSpec {
  do_resize?: boolean;
  do_center_crop?: boolean;
  size?: { shortest_edge?: number; width?: number; height?: number };
  crop_size?: number | { width: number; height: number };
  /** PIL resampling id: 0 nearest, 2 bilinear, 3 bicubic. */
  resample?: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS_BY_COLOR_TYPE: Record<number, Pixels['channels']> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit, non-interlaced grey / RGB / grey-alpha / RGBA PNG (what Bun.Image writes). */
export function decodePng(bytes: Uint8Array): Pixels {
  if (bytes.length < 8 || PNG_SIGNATURE.some((v, i) => bytes[i] !== v)) {
    throw new Error('decodePng: not a PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let channels: Pixels['channels'] | undefined;
  const idat: Uint8Array[] = [];
  for (let pos = 8; pos + 8 <= bytes.length;) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const body = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const [depth, colorType, , , interlace] = body.subarray(8, 13);
      channels = CHANNELS_BY_COLOR_TYPE[colorType ?? -1];
      if (depth !== 8 || channels === undefined || interlace !== 0) {
        throw new Error(
          `decodePng: unsupported PNG (depth ${depth}, color type ${colorType}, interlace ${interlace})`
        );
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (channels === undefined || idat.length === 0)
    throw new Error('decodePng: missing IHDR or IDAT');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error('decodePng: truncated image data');
  const data = new Uint8ClampedArray(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? data[out + x - channels]! : 0;
      const up = y > 0 ? data[out - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? data[out - stride + x - channels]! : 0;
      const v = raw[src + x]!;
      let predicted: number;
      switch (filter) {
        case 0:
          predicted = 0;
          break;
        case 1:
          predicted = left;
          break;
        case 2:
          predicted = up;
          break;
        case 3:
          predicted = (left + up) >> 1;
          break;
        case 4:
          predicted = paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`decodePng: unknown filter ${filter} on row ${y}`);
      }
      data[out + x] = (v + predicted) & 0xff;
    }
  }
  return { data, width, height, channels };
}

/** transformers.js `get_resize_output_image_size` for the two size shapes our models use. */
export function resizedSize(width: number, height: number, spec: ResizeSpec): [number, number] {
  const size = spec.size;
  if (size?.shortest_edge !== undefined) {
    const factor = Math.max(size.shortest_edge / width, size.shortest_edge / height);
    return [
      Math.floor(Number((width * factor).toFixed(2))),
      Math.floor(Number((height * factor).toFixed(2))),
    ];
  }
  if (size?.width !== undefined && size.height !== undefined) return [size.width, size.height];
  return [width, height];
}

/** Center crop to `cropWidth` x `cropHeight`, padding with black where the image is smaller. */
export function centerCrop(image: Pixels, cropWidth: number, cropHeight: number): Pixels {
  if (image.width === cropWidth && image.height === cropHeight) return image;
  const { channels } = image;
  const offsetX = Math.floor((image.width - cropWidth) / 2);
  const offsetY = Math.floor((image.height - cropHeight) / 2);
  const data = new Uint8ClampedArray(cropWidth * cropHeight * channels);
  for (let y = 0; y < cropHeight; y++) {
    const sy = y + offsetY;
    if (sy < 0 || sy >= image.height) continue;
    for (let x = 0; x < cropWidth; x++) {
      const sx = x + offsetX;
      if (sx < 0 || sx >= image.width) continue;
      const from = (sy * image.width + sx) * channels;
      data.set(image.data.subarray(from, from + channels), (y * cropWidth + x) * channels);
    }
  }
  return { data, width: cropWidth, height: cropHeight, channels };
}

const FILTERS: Record<number, 'nearest' | 'bilinear' | 'cubic' | 'lanczos3'> = {
  0: 'nearest',
  1: 'lanczos3',
  2: 'bilinear',
  3: 'cubic',
};

/** Decode `bytes` (JPEG / PNG / WebP / GIF), resize and center-crop it as the processor would. */
export async function prepareImage(bytes: Uint8Array, spec: ResizeSpec): Promise<Pixels> {
  const { width, height } = await new Bun.Image(bytes).metadata();
  const [w, h] = spec.do_resize === false ? [width, height] : resizedSize(width, height, spec);
  const png = await new Bun.Image(bytes)
    .resize(w, h, { filter: FILTERS[spec.resample ?? 2] ?? 'bilinear' })
    .png()
    .bytes();
  const resized = decodePng(png);
  const crop = spec.crop_size;
  if (!spec.do_center_crop || crop === undefined) return resized;
  return typeof crop === 'number'
    ? centerCrop(resized, crop, crop)
    : centerCrop(resized, crop.width, crop.height);
}
