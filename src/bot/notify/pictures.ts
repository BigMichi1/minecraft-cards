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

export type DownloadFn = (url: string) => Promise<Uint8Array>;

/** Discord allows 10 attachments per message; 5 embeds with picture and thumbnail fit exactly. */
export const MAX_ATTACHMENTS = 10;
/** Stay well under Discord's upload limit per message; shop pictures are about 100 KB. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

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
 * attached, n being the embed's 1-based position. Never rejects; returns `message` itself when
 * nothing was attached.
 */
export async function attachPictures(
  message: MessageCreateOptions,
  download: DownloadFn
): Promise<MessageCreateOptions> {
  try {
    return await attachAll(message, download);
  } catch (error) {
    // A picture must never cost the alert: send it as built, with the picture URLs.
    logError('attaching notification pictures failed', error, 'warn');
    return message;
  }
}

async function attachAll(
  message: MessageCreateOptions,
  download: DownloadFn
): Promise<MessageCreateOptions> {
  const embeds = message.embeds ?? [];
  const files: AttachmentPayload[] = [...((message.files ?? []) as AttachmentPayload[])];
  const downloads = new Map<string, Promise<Uint8Array | null>>();
  let bytesUsed = 0;
  let attached = 0;

  const fetchOnce = (url: string): Promise<Uint8Array | null> => {
    let pending = downloads.get(url);
    if (!pending) {
      pending = download(url).catch((error: unknown) => {
        logger.warn(`notification picture ${url} not attached: ${errorMessage(error)}`);
        return null;
      });
      downloads.set(url, pending);
    }
    return pending;
  };

  /** The attachment:// URL for `url`, or null to keep the URL. */
  const attach = async (url: string | undefined, name: string): Promise<string | null> => {
    if (!url || !allowedImageUrl(url) || files.length >= MAX_ATTACHMENTS) return null;
    const bytes = await fetchOnce(url);
    if (!bytes) return null;
    const ext = pictureExtension(bytes);
    if (!ext) {
      logger.warn(`notification picture ${url} not attached: not a JPEG, PNG, GIF or WebP`);
      return null;
    }
    if (bytesUsed + bytes.byteLength > MAX_ATTACHMENT_BYTES) return null;
    bytesUsed += bytes.byteLength;
    const fileName = `${name}.${ext}`;
    files.push({ attachment: Buffer.from(bytes), name: fileName });
    attached++;
    return `attachment://${fileName}`;
  };

  const out: (APIEmbed | EmbedBuilder | (typeof embeds)[number])[] = [];
  for (const [i, embed] of embeds.entries()) {
    const json = toJson(embed);
    const image = await attach(json.image?.url, `picture-${i + 1}`);
    const thumbnail = await attach(json.thumbnail?.url, `reference-${i + 1}`);
    if (!image && !thumbnail) {
      out.push(embed);
      continue;
    }
    const builder = new EmbedBuilder(json);
    if (image) builder.setImage(image);
    if (thumbnail) builder.setThumbnail(thumbnail);
    out.push(builder);
  }
  if (attached === 0) return message;
  return { ...message, embeds: out, files };
}
