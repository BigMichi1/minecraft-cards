/**
 * The admin's one-click buttons on a listing DM: Confirm (what `/admin map` does with the
 * listing's current cards, without re-notifying anyone) and Dismiss (what `/admin clear` does).
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import type { APIEmbedField, ButtonInteraction } from 'discord.js';
import { normalizeCardId, type CardId } from '../cards/cardId';
import { catalogManager } from '../database/catalogManager';
import { listingManager, type StoredListing } from '../database/listingManager';
import { validUrl } from '../notify/messages';
import { logError } from '../utils/logger';
import { replyWithError } from '../utils/interactionReply';
import { clipText } from '../utils/messageLimit';

/** Discord's limit for a component's customId. */
const MAX_CUSTOM_ID = 100;
const MAX_FIELD = 1024;
const NO_LISTING = 'This listing no longer exists.';
const NOT_ADMIN = 'Only the admin can do this.';
const CARDS_CHANGED = "The listing's cards changed since this message; use /admin map.";

interface AdminDeps {
  adminId: string;
}

const ephemeral = (content: string) => ({ content, flags: MessageFlags.Ephemeral as const });

/**
 * The listing as the admin sees it: `lead` fields first, then cards, shop and URL, the listing
 * picture, and the reference of its first card as thumbnail.
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
  const reference = listing.cardIds[0] ? catalogManager.getCard(listing.cardIds[0]) : undefined;
  const thumbnail = validUrl(reference?.referenceImageUrl);
  if (thumbnail) embed.setThumbnail(thumbnail);
  return embed;
}

/**
 * Confirm (when the listing has cards and their ids fit a customId) and, with `dismiss`, Dismiss;
 * null when neither applies.
 */
export function adminActionRow(
  listing: StoredListing,
  opts: { dismiss: boolean }
): ActionRowBuilder<ButtonBuilder> | null {
  const buttons: ButtonBuilder[] = [];
  const confirmId = `admin-confirm:${listing.id}:${listing.cardIds.join(',')}`;
  const [first] = listing.cardIds;
  if (first && confirmId.length <= MAX_CUSTOM_ID) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Success)
        .setLabel(listing.cardIds.length > 1 ? '✅ Confirm bundle' : `✅ Confirm #${first}`)
        .setCustomId(confirmId)
    );
  }
  if (opts.dismiss) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setLabel('🗑️ Dismiss')
        .setCustomId(`admin-dismiss:${listing.id}`)
    );
  }
  return buttons.length > 0 ? new ActionRowBuilder<ButtonBuilder>().addComponents(buttons) : null;
}

function parseListingId(value: string | undefined): number | null {
  return value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

/** `admin-confirm:<listingId>:<cardIds>`; null when malformed. */
function parseConfirmId(customId: string): { listingId: number; cardIds: CardId[] } | null {
  const parts = customId.split(':');
  if (parts.length !== 3) return null;
  const listingId = parseListingId(parts[1]);
  if (listingId === null || !parts[2]) return null;
  const cardIds: CardId[] = [];
  for (const raw of parts[2].split(',')) {
    const id = normalizeCardId(raw);
    if (!id) return null;
    cardIds.push(id);
  }
  return { listingId, cardIds };
}

/** Mark the admin's DM as handled: status line appended, buttons removed. */
async function markHandled(i: ButtonInteraction, status: string): Promise<void> {
  const suffix = `\n${status}`;
  const content = `${clipText(i.message.content, 2000 - suffix.length)}${suffix}`;
  await i.update({ content, components: [] });
}

export async function handleAdminConfirm(i: ButtonInteraction, deps: AdminDeps): Promise<void> {
  try {
    if (i.user.id !== deps.adminId) {
      await i.reply(ephemeral(NOT_ADMIN));
      return;
    }
    const parsed = parseConfirmId(i.customId);
    const result = parsed
      ? listingManager.confirmCards(parsed.listingId, parsed.cardIds, Date.now())
      : undefined;
    if (result === undefined) {
      await i.reply(ephemeral(NO_LISTING));
      return;
    }
    if (result === 'changed') {
      await i.reply(ephemeral(CARDS_CHANGED));
      return;
    }
    await markHandled(i, '✅ Confirmed');
  } catch (err) {
    logError('[ADMIN ACTION] confirm failed', err);
    await replyWithError(i, 'Confirm failed', 'Something went wrong. Please try again later.');
  }
}

export async function handleAdminDismiss(i: ButtonInteraction, deps: AdminDeps): Promise<void> {
  try {
    if (i.user.id !== deps.adminId) {
      await i.reply(ephemeral(NOT_ADMIN));
      return;
    }
    const parts = i.customId.split(':');
    const listingId = parts.length === 2 ? parseListingId(parts[1]) : null;
    const listing = listingId === null ? undefined : listingManager.getById(listingId);
    if (!listing || !listingManager.clearHold(listing.url)) {
      await i.reply(ephemeral(NO_LISTING));
      return;
    }
    await markHandled(i, '🗑️ Dismissed');
  } catch (err) {
    logError('[ADMIN ACTION] dismiss failed', err);
    await replyWithError(i, 'Dismiss failed', 'Something went wrong. Please try again later.');
  }
}
