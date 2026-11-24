/**
 * The admin's side of a listing DM (a user's Right, a wrong-card report): the shared listing
 * embed, `withPictures` that attaches its pictures, and the one-click buttons Confirm (what
 * `/admin map` does with the listing's current cards, without re-notifying anyone) and Dismiss
 * (what `/admin clear` does).
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { APIEmbedField, ButtonInteraction, MessageCreateOptions } from 'discord.js';
import { catalogManager } from '../database/catalogManager';
import { listingManager, type StaleReason, type StoredListing } from '../database/listingManager';
import { downloadImage } from '../matcher/embedder';
import { validUrl } from '../notify/messages';
import { attachPictures, PictureRun, type DownloadFn } from '../notify/pictures';
import { isPayloadRejection } from '../notify/sender';
import { ephemeral, replyWithError } from '../utils/interactionReply';
import logger, { logError } from '../utils/logger';
import { clipText, DISCORD_MESSAGE_LIMIT } from '../utils/messageLimit';
import { decodeConfirmId, decodeDismissId, encodeConfirmId, encodeDismissId } from './buttonIds';

/** Discord's limit for an embed field value. */
export const MAX_FIELD = 1024;
export const NO_LISTING = 'This listing no longer exists.';
export const INVALID_BUTTON = 'This button is not valid.';
const NOT_ADMIN = 'Only the admin can do this.';
/** Why Confirm was refused, as the admin reads it. */
export const STALE_REPLIES: Record<StaleReason, string> = {
  cards: "The listing's cards changed since this message; look again or use /admin map.",
  picture: "The listing's picture changed since this message; look again or use /admin map.",
  status:
    "The listing's picture check is due again or found another card; look again or use /admin map.",
};

/** A DM to the admin. */
export type AdminDm = (msg: MessageCreateOptions) => Promise<void>;

/** What the admin-only handlers need: who the admin is, and a clock for tests. */
export interface AdminDeps {
  adminId: string;
  now?: () => number;
}

const defaultDownload: DownloadFn = (url, maxBytes) => downloadImage(url, undefined, maxBytes);

/**
 * `send` with the embed pictures attached, as user alerts do: Discord's proxy shows no collect-it
 * pictures, and the admin confirms by the picture. A picture that cannot be attached keeps its
 * URL. A DM Discord refuses as a bad payload (400/413, never 50007) is resent once without the
 * pictures, and the error of that resend is the one raised; any other failure is raised as it is,
 * with no second send. Fallbacks here are only logged, never the `notify-pictures` alert: the
 * admin is the reader of this DM and sees a missing picture.
 */
export function withPictures(send: AdminDm, download: DownloadFn = defaultDownload): AdminDm {
  return async (message) => {
    const attached = await attachPictures(message, new PictureRun(download));
    if (attached === message) {
      await send(message);
      return;
    }
    try {
      await send(attached);
    } catch (error) {
      if (!isPayloadRejection(error)) throw error;
      logError(
        `Admin DM "${embedTitle(message)}" with pictures rejected, resending without them`,
        error,
        'warn'
      );
      await send(message);
    }
  };
}

/** The first embed's title, which names the listing, for log lines about a DM. */
function embedTitle(message: MessageCreateOptions): string {
  const [first] = message.embeds ?? [];
  const json = first && 'toJSON' in first ? first.toJSON() : first;
  return clipText(json?.title ?? 'untitled', 200);
}

/**
 * The listing as the admin sees it: `lead` fields first, then cards, shop and URL, the listing
 * picture, and the usable reference of its first card as thumbnail (never a placeholder).
 */
export function adminListingEmbed(
  listing: StoredListing,
  title: string,
  lead: APIEmbedField[] = []
): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(title).addFields(
    ...lead,
    {
      name: 'Cards',
      value: clipText(listing.cardIds.map((id) => `#${id}`).join(', ') || 'none', MAX_FIELD),
      inline: true,
    },
    { name: 'Shop', value: listing.shop, inline: true },
    { name: 'URL', value: clipText(listing.url, MAX_FIELD) }
  );
  const url = validUrl(listing.url);
  if (url) embed.setURL(url);
  const image = validUrl(listing.imageUrl);
  if (image) embed.setImage(image);
  const [first] = listing.cardIds;
  const reference = first
    ? catalogManager.referenceCatalog(listing.collection).usable.find((c) => c.cardId === first)
    : undefined;
  const thumbnail = validUrl(reference?.referenceImageUrl);
  if (thumbnail) embed.setThumbnail(thumbnail);
  return embed;
}

/**
 * Confirm (when the listing has cards and its Confirm id, picture fingerprint included, fits
 * Discord's 100 characters) and, with `dismiss`, Dismiss; null when neither applies.
 */
export function adminActionRow(
  listing: StoredListing,
  opts: { dismiss: boolean }
): ActionRowBuilder<ButtonBuilder> | null {
  const buttons: ButtonBuilder[] = [];
  const confirmId = encodeConfirmId(listing);
  if (confirmId) {
    const [first] = listing.cardIds;
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Success)
        .setLabel(listing.cardIds.length > 1 ? '✅ Confirm bundle' : `✅ Confirm #${first}`)
        .setCustomId(confirmId)
    );
  } else if (listing.cardIds.length > 0) {
    logger.warn(
      `[ADMIN ACTION] Confirm button left out for listing ${listing.id}: its id would pass 100 characters`
    );
  }
  if (opts.dismiss) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setLabel('🗑️ Dismiss')
        .setCustomId(encodeDismissId(listing.id))
    );
  }
  return buttons.length > 0 ? new ActionRowBuilder<ButtonBuilder>().addComponents(buttons) : null;
}

/** A button whose id did not parse: a wrong format or a button of an older build. */
export async function rejectInvalidButton(i: ButtonInteraction, tag: string): Promise<void> {
  logger.warn(`${tag} button with an unreadable id: ${clipText(i.customId, 200)}`);
  await i.reply(ephemeral(INVALID_BUTTON));
}

/**
 * Mark the admin's DM as handled: status line appended, buttons removed. When the DM cannot be
 * updated, the action already took effect, so the admin is told that instead of a failure; when
 * that notice cannot be delivered either, it is only logged. Never throws.
 */
async function markHandled(i: ButtonInteraction, status: string, done: string): Promise<void> {
  const room = DISCORD_MESSAGE_LIMIT - status.length - 1;
  const content = [clipText(i.message.content, room), status].filter(Boolean).join('\n');
  try {
    await i.update({ content, components: [] });
    return;
  } catch (err) {
    logError(`[ADMIN ACTION] ${done}, but the DM ${i.customId} could not be updated`, err, 'warn');
  }
  try {
    await i.reply(ephemeral(`${done}; this message could not be updated.`));
  } catch (err) {
    // An expired interaction fails both ways; the action stands, so this is no failure of it.
    logError(
      `[ADMIN ACTION] ${done} (${i.customId}), but the admin could not be told`,
      err,
      'warn'
    );
  }
}

export async function handleAdminConfirm(i: ButtonInteraction, deps: AdminDeps): Promise<void> {
  try {
    if (i.user.id !== deps.adminId) {
      await i.reply(ephemeral(NOT_ADMIN));
      return;
    }
    const parsed = decodeConfirmId(i.customId);
    if (!parsed) {
      await rejectInvalidButton(i, '[ADMIN ACTION] Confirm');
      return;
    }
    const now = (deps.now ?? Date.now)();
    const result = listingManager.confirmCards(parsed, now);
    if (result.kind === 'gone') {
      await i.reply(ephemeral(NO_LISTING));
      return;
    }
    if (result.kind === 'stale') {
      logger.info(
        `[ADMIN ACTION] Confirm of listing ${parsed.listingId} refused: ${result.reason} changed`
      );
      await i.reply(ephemeral(STALE_REPLIES[result.reason]));
      return;
    }
    logger.info(
      `[ADMIN ACTION] listing ${parsed.listingId} confirmed as ${parsed.cardIds.join(', ')} by the admin`
    );
    await markHandled(i, '✅ Confirmed', 'Confirmed');
  } catch (err) {
    logError(`[ADMIN ACTION] Confirm ${i.customId} failed`, err);
    await replyWithError(i, 'Confirm failed', 'Something went wrong. Please try again later.');
  }
}

export async function handleAdminDismiss(i: ButtonInteraction, deps: AdminDeps): Promise<void> {
  try {
    if (i.user.id !== deps.adminId) {
      await i.reply(ephemeral(NOT_ADMIN));
      return;
    }
    const listingId = decodeDismissId(i.customId);
    if (listingId === null) {
      await rejectInvalidButton(i, '[ADMIN ACTION] Dismiss');
      return;
    }
    const listing = listingManager.getById(listingId);
    if (!listing || !listingManager.clearHold(listing.url)) {
      await i.reply(ephemeral(NO_LISTING));
      return;
    }
    logger.info(`[ADMIN ACTION] listing ${listingId} dismissed by the admin`);
    await markHandled(i, '🗑️ Dismissed', 'Dismissed');
  } catch (err) {
    logError(`[ADMIN ACTION] Dismiss ${i.customId} failed`, err);
    await replyWithError(i, 'Dismiss failed', 'Something went wrong. Please try again later.');
  }
}
