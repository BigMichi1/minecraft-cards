/**
 * A user's "✅ Right #<card>" on an unconfirmed alert: the admin gets the listing with a one-click
 * Confirm, at most once a day per listing. No hold and no report: the alert stays as it is.
 */
import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, MessageCreateOptions } from 'discord.js';
import { listingManager } from '../database/listingManager';
import { runManager } from '../database/runManager';
import { logError } from '../utils/logger';
import { replyWithError } from '../utils/interactionReply';
import { clipText } from '../utils/messageLimit';
import { adminActionRow, adminListingEmbed } from './adminActions';

/** One admin DM per listing within this period, however many users click. */
const REQUEST_EVERY_MS = 24 * 60 * 60 * 1000;
const MAX_FIELD = 1024;

type NotifyAdmin = (msg: MessageCreateOptions) => Promise<void>;

const ephemeral = (content: string) => ({ content, flags: MessageFlags.Ephemeral as const });

/** `right:<listingId>`; null when malformed. */
function parseRightId(customId: string): number | null {
  const parts = customId.split(':');
  return parts.length === 2 && /^\d{1,15}$/.test(parts[1]!) ? Number(parts[1]) : null;
}

export async function handleRightButton(
  i: ButtonInteraction,
  notifyAdmin: NotifyAdmin,
  now: () => number = Date.now
): Promise<void> {
  try {
    const listingId = parseRightId(i.customId);
    const listing = listingId === null ? undefined : listingManager.getById(listingId);
    if (!listing) {
      await i.reply(ephemeral('This listing no longer exists.'));
      return;
    }
    if (listing.manualOverride && listing.matchStatus === 'confirmed') {
      await i.reply(ephemeral('Already confirmed by the admin.'));
      return;
    }
    // Acknowledge first: the admin DM must not eat Discord's 3 s window.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const key = `confirm-request:${listing.id}`;
    const previous = runManager.lastAlertAt(key);
    if (!runManager.shouldAlert(key, now(), REQUEST_EVERY_MS)) {
      await i.editReply({ content: 'Thanks — the admin already has this one.' });
      return;
    }
    const by = `${i.user.tag ?? i.user.username} (${i.user.id})`;
    const row = adminActionRow(listing, { dismiss: false });
    try {
      await notifyAdmin({
        embeds: [
          adminListingEmbed(listing, `👍 Card confirmed by a user (listing ${listing.id})`, [
            { name: 'By', value: clipText(by, MAX_FIELD), inline: true },
          ]),
        ],
        ...(row ? { components: [row] } : {}),
      });
    } catch (err) {
      // Not sent: free the throttle so the next click tries again.
      runManager.releaseAlert(key, previous);
      logError(`[RIGHT] Could not notify the admin about listing ${listing.id}`, err);
      await i.editReply({
        content: 'The admin could not be reached just now. Please try again later.',
      });
      return;
    }
    await i.editReply({ content: 'Thanks — the admin has been notified.' });
  } catch (err) {
    logError('[RIGHT] button failed', err);
    await replyWithError(i, 'Confirm failed', 'Something went wrong. Please try again later.');
  }
}
