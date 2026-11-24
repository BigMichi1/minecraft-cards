/**
 * A user's "✅ Right #<card>" on an unconfirmed alert: the admin gets the listing with a one-click
 * Confirm, at most once a day per listing. No hold and no report: the alert stays as it is.
 */
import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, MessageCreateOptions } from 'discord.js';
import { listingManager, type StoredListing } from '../database/listingManager';
import { runManager } from '../database/runManager';
import { isAdminConfirmed } from '../matcher/matchStatus';
import { ephemeral, replyWithError } from '../utils/interactionReply';
import { logError } from '../utils/logger';
import { clipText, DISCORD_MESSAGE_LIMIT } from '../utils/messageLimit';
import {
  adminActionRow,
  adminListingEmbed,
  NO_LISTING,
  rejectInvalidButton,
  type AdminDm,
} from './adminActions';
import { decodeRightId } from './buttonIds';

/** One admin DM per listing within this period, however many users click. */
const REQUEST_EVERY_MS = 24 * 60 * 60 * 1000;
const MAX_FIELD = 1024;

export interface RightDeps {
  notifyAdmin: AdminDm;
  now?: () => number;
}

/** The admin's DM: the listing, who vouched for it, Confirm when it fits, and the command. */
function buildRightMessage(listing: StoredListing, i: ButtonInteraction): MessageCreateOptions {
  const by = `${i.user.tag ?? i.user.username} (${i.user.id})`;
  const row = adminActionRow(listing, { dismiss: false });
  return {
    content: clipText(
      `Confirm below, or fix with \`/admin map url:${listing.url} cards:${listing.cardIds.join(',')}\`.`,
      DISCORD_MESSAGE_LIMIT
    ),
    embeds: [
      adminListingEmbed(listing, `👍 Card confirmed by a user (listing ${listing.id})`, [
        { name: 'By', value: clipText(by, MAX_FIELD), inline: true },
      ]),
    ],
    ...(row ? { components: [row] } : {}),
  };
}

export async function handleRightButton(i: ButtonInteraction, deps: RightDeps): Promise<void> {
  try {
    const listingId = decodeRightId(i.customId);
    if (listingId === null) {
      await rejectInvalidButton(i, '[RIGHT]');
      return;
    }
    const listing = listingManager.getById(listingId);
    if (!listing) {
      await i.reply(ephemeral(NO_LISTING));
      return;
    }
    if (isAdminConfirmed(listing)) {
      await i.reply(ephemeral('Already confirmed by the admin.'));
      return;
    }
    if (listing.matchStatus !== 'unconfirmed') {
      await i.reply(
        ephemeral('This listing changed since the alert; there is nothing to confirm now.')
      );
      return;
    }
    // Built before the throttle is taken: a failure here must not hold it for a day.
    const message = buildRightMessage(listing, i);
    // Acknowledge first: the admin DM must not eat Discord's 3 s window.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const key = `confirm-request:${listing.id}`;
    const previous = runManager.lastAlertAt(key);
    if (!runManager.shouldAlert(key, (deps.now ?? Date.now)(), REQUEST_EVERY_MS)) {
      await i.editReply({ content: 'Thanks — the admin already has this one.' });
      return;
    }
    try {
      await deps.notifyAdmin(message);
    } catch (err) {
      logError(`[RIGHT] Could not notify the admin about listing ${listing.id}`, err);
      // Not sent: free the throttle so the next click tries again.
      try {
        runManager.releaseAlert(key, previous);
      } catch (releaseErr) {
        logError(
          `[RIGHT] Could not free the request throttle of listing ${listing.id}`,
          releaseErr
        );
      }
      await i.editReply({
        content: 'The admin could not be reached just now. Please try again later.',
      });
      return;
    }
    await i.editReply({ content: 'Thanks — the admin has been notified.' });
  } catch (err) {
    logError(`[RIGHT] button ${i.customId} failed`, err);
    await replyWithError(i, 'Confirm failed', 'Something went wrong. Please try again later.');
  }
}
