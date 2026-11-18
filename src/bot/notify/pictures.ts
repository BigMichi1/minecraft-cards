/**
 * Attach notification pictures to the DM instead of linking them.
 *
 * Discord's media proxy cannot load some shop pictures (collect-it.de shows none, most likely
 * because the shop blocks datacenter IPs), so the bot downloads each embed image and thumbnail
 * itself, attaches it and points the embed at `attachment://<name>`. Any picture that cannot be
 * attached (host not allowed, download failed, not a known image format, attachment limit or
 * byte budget reached) keeps its URL, so an alert is never lost because of a picture.
 */
import {
  EmbedBuilder,
  type APIEmbed,
  type AttachmentPayload,
  type MessageCreateOptions,
} from 'discord.js';
import { allowedImageUrl } from '../matcher/embedder';
import { errorMessage } from '../utils/async';
import logger, { logError } from '../utils/logger';

/** Downloads a picture, refusing it as soon as it is over `maxBytes`. */
export type DownloadFn = (url: string, maxBytes: number) => Promise<Uint8Array>;

/** Discord allows 10 attachments per message; 5 embeds with picture and thumbnail fit exactly. */
export const MAX_ATTACHMENTS = 10;
/** Stay well under Discord's upload limit per message; shop pictures are about 100 KB. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** Cap of one notification picture, enforced while downloading (matching allows 10 MB). */
export const MAX_PICTURE_BYTES = 2 * 1024 * 1024;

/** Why a picture kept its URL. */
type Fallback =
  | 'host not allowed'
  | 'download failed'
  | 'not a JPEG, PNG, GIF or WebP'
  | 'attachment limit'
  | 'byte budget';

/** Fallbacks about the message size, not the host; they never count toward the alert. */
const SIZE_FALLBACKS: ReadonlySet<Fallback> = new Set(['attachment limit', 'byte budget']);

interface HostStats {
  total: number;
  failed: number;
  /** Fallback reason, with the first error text for failed downloads. */
  reasons: Map<Fallback, string | undefined>;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(invalid URL)';
  }
}

/**
 * The picture state of one sender run: a download cache shared by all its messages (a reference
 * thumbnail is fetched once), each warning logged once per reason, and per-host outcomes for the
 * admin alert.
 */
export class PictureRun {
  private readonly downloads = new Map<string, Promise<Uint8Array | Error>>();
  private readonly warned = new Set<Fallback>();
  private readonly hosts = new Map<string, HostStats>();

  constructor(private readonly download: DownloadFn) {}

  /** The picture's bytes, or the download error; never rejects. */
  fetch(url: string): Promise<Uint8Array | Error> {
    let pending = this.downloads.get(url);
    if (!pending) {
      pending = this.download(url, MAX_PICTURE_BYTES).catch((error: unknown) => {
        logger.warn(`notification picture ${url} not attached: ${errorMessage(error)}`);
        return error instanceof Error ? error : new Error(errorMessage(error));
      });
      this.downloads.set(url, pending);
    }
    return pending;
  }

  /** Count one picture: attached (`fallback` undefined) or kept as URL for `fallback`. */
  record(url: string, fallback?: Fallback, detail?: string): void {
    if (fallback && SIZE_FALLBACKS.has(fallback)) return;
    const host = hostOf(url);
    const stats = this.hosts.get(host) ?? { total: 0, failed: 0, reasons: new Map() };
    this.hosts.set(host, stats);
    stats.total++;
    if (!fallback) return;
    stats.failed++;
    if (!stats.reasons.has(fallback)) stats.reasons.set(fallback, detail);
  }

  /** Log `text` at warn, at most once per run for each reason. */
  warnOnce(fallback: Fallback, text: string): void {
    if (this.warned.has(fallback)) return;
    this.warned.add(fallback);
    logger.warn(text);
  }

  /**
   * The admin alert text for this run, or null. It fires when more than half of the counted
   * pictures fell back, or when every picture of a host did. Counted are attached pictures and
   * those that fell back for their host (not allowed, download failed, not a picture); the
   * attachment limit and the byte budget are about the message and are only logged.
   */
  alertText(): string | null {
    let total = 0;
    let failed = 0;
    let hostDown = false;
    for (const stats of this.hosts.values()) {
      total += stats.total;
      failed += stats.failed;
      if (stats.failed > 0 && stats.failed === stats.total) hostDown = true;
    }
    if (failed === 0 || (!hostDown && failed * 2 <= total)) return null;
    const parts = [...this.hosts.entries()]
      .filter(([, stats]) => stats.failed > 0)
      .map(([host, stats]) => {
        const reasons = [...stats.reasons.entries()]
          .map(([reason, detail]) => (detail ? `${reason}: ${detail}` : reason))
          .join('; ');
        return `${host} ${stats.failed} of ${stats.total} (${reasons})`;
      });
    return `Notification pictures fell back to their URLs: ${parts.join(', ')}.`;
  }
}

/** The file extension of a JPEG, PNG, GIF or WebP picture from its first bytes, else null. */
export function pictureExtension(bytes: Uint8Array): 'jpg' | 'png' | 'gif' | 'webp' | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

function toJson(embed: NonNullable<MessageCreateOptions['embeds']>[number]): APIEmbed {
  return 'toJSON' in embed && typeof embed.toJSON === 'function'
    ? embed.toJSON()
    : (embed as APIEmbed);
}

/**
 * Returns `message` with each embed's image (`picture-<n>`) and thumbnail (`reference-<n>`)
 * attached, n being the embed's 1-based position. The message's downloads run in parallel
 * through `run`'s cache. Never rejects; returns `message` itself when nothing was attached.
 */
export async function attachPictures(
  message: MessageCreateOptions,
  run: PictureRun
): Promise<MessageCreateOptions> {
  try {
    return await attachAll(message, run);
  } catch (error) {
    // A picture must never cost the alert: send it as built, with the picture URLs.
    logError('attaching notification pictures failed', error, 'warn');
    return message;
  }
}

interface Slot {
  embed: number;
  kind: 'image' | 'thumbnail';
  url: string;
  bytes?: Promise<Uint8Array | Error>;
}

async function attachAll(
  message: MessageCreateOptions,
  run: PictureRun
): Promise<MessageCreateOptions> {
  const embeds = message.embeds ?? [];
  const json = embeds.map(toJson);
  const slots: Slot[] = [];
  json.forEach((e, embed) => {
    if (e.image?.url) slots.push({ embed, kind: 'image', url: e.image.url });
    if (e.thumbnail?.url) slots.push({ embed, kind: 'thumbnail', url: e.thumbnail.url });
  });
  // Start every download of the message at once; results are assigned in slot order below.
  for (const slot of slots) {
    if (allowedImageUrl(slot.url)) slot.bytes = run.fetch(slot.url);
  }
  const results = await Promise.all(slots.map((slot) => slot.bytes));

  const files: AttachmentPayload[] = [...((message.files ?? []) as AttachmentPayload[])];
  const attachedUrls = new Map<number, { image?: string; thumbnail?: string }>();
  let bytesUsed = 0;
  slots.forEach((slot, i) => {
    const bytes = results[i];
    if (bytes === undefined) {
      run.record(slot.url, 'host not allowed');
      run.warnOnce(
        'host not allowed',
        `notification picture ${slot.url} not attached: host not allowed (further ones this run not logged)`
      );
      return;
    }
    if (bytes instanceof Error) {
      run.record(slot.url, 'download failed', bytes.message);
      return;
    }
    const ext = pictureExtension(bytes);
    if (!ext) {
      run.record(slot.url, 'not a JPEG, PNG, GIF or WebP');
      logger.warn(`notification picture ${slot.url} not attached: not a JPEG, PNG, GIF or WebP`);
      return;
    }
    if (files.length >= MAX_ATTACHMENTS) {
      run.record(slot.url, 'attachment limit');
      run.warnOnce(
        'attachment limit',
        `notification picture ${slot.url} not attached: attachment limit of ${MAX_ATTACHMENTS} per message reached`
      );
      return;
    }
    if (bytesUsed + bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      run.record(slot.url, 'byte budget');
      run.warnOnce(
        'byte budget',
        `notification picture ${slot.url} not attached: byte budget of ${MAX_ATTACHMENT_BYTES} per message reached`
      );
      return;
    }
    bytesUsed += bytes.byteLength;
    const name = `${slot.kind === 'image' ? 'picture' : 'reference'}-${slot.embed + 1}.${ext}`;
    files.push({ attachment: Buffer.from(bytes), name });
    run.record(slot.url);
    const entry = attachedUrls.get(slot.embed) ?? {};
    entry[slot.kind] = `attachment://${name}`;
    attachedUrls.set(slot.embed, entry);
  });

  if (attachedUrls.size === 0) return message;
  const out = embeds.map((embed, i) => {
    const attached = attachedUrls.get(i);
    if (!attached) return embed;
    const builder = new EmbedBuilder(json[i]);
    if (attached.image) builder.setImage(attached.image);
    if (attached.thumbnail) builder.setThumbnail(attached.thumbnail);
    return builder;
  });
  return { ...message, embeds: out, files };
}
