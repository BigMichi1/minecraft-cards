import type { MessageCreateOptions } from 'discord.js';
import type { NotificationSender, PendingNotifications } from '../check/runner';
import { listingManager } from '../database/listingManager';
import { userManager } from '../database/userManager';
import logger from '../utils/logger';
import { buildNotificationMessages, ITEMS_PER_MESSAGE, type NotificationMessage } from './messages';

/** The only part of the Discord client the sender needs. */
export interface DmClient {
  users: {
    fetch(id: string): Promise<{ send(options: MessageCreateOptions): Promise<unknown> }>;
  };
}

export interface SenderOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** True once the bot is stopping: a DM failing then is the shutdown, not closed DMs. */
  isShuttingDown?: () => boolean;
}

const PAUSE_MS = 500;
/** A first list can match hundreds of listings; the rest arrive in later runs. */
export const MAX_MESSAGES_PER_RUN = 5;
const MAX_ITEMS_PER_RUN = MAX_MESSAGES_PER_RUN * ITEMS_PER_MESSAGE;

function heldBackText(count: number): string {
  return `…and ${count} more listings will follow in the next checks.`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDiscordSender(
  client: DmClient,
  options: SenderOptions = {}
): NotificationSender {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const isShuttingDown = options.isShuttingDown ?? (() => false);

  return {
    async send(pending: PendingNotifications) {
      let notified = 0;
      let dmFailures = 0;
      let first = true;
      for (const [discordId, items] of pending) {
        let messages: NotificationMessage[];
        // Held-back items stay unrecorded, so the next run picks them up.
        const heldBack = Math.max(0, items.length - MAX_ITEMS_PER_RUN);
        try {
          messages = buildNotificationMessages(items.slice(0, MAX_ITEMS_PER_RUN));
          const last = messages[messages.length - 1];
          if (heldBack > 0 && last) {
            last.message = { ...last.message, content: heldBackText(heldBack) };
          }
        } catch (error) {
          // Not a DM problem: leave the items unrecorded so they are retried next run.
          logger.error(`building notifications for ${discordId} failed: ${errorText(error)}`);
          continue;
        }
        try {
          const user = await client.users.fetch(discordId);
          for (const { message, items: sent } of messages) {
            if (!first) await sleep(PAUSE_MS);
            first = false;
            await user.send(message);
            for (const { listing } of sent) {
              listingManager.recordNotified(discordId, listing.id, listing.availableSince ?? now());
              notified++;
            }
          }
        } catch (error) {
          if (isShuttingDown()) {
            // The client is going away; the user's DMs may be fine. Unsent items are retried.
            logger.info(`DM to ${discordId} interrupted by shutdown: ${errorText(error)}`);
            continue;
          }
          dmFailures++;
          logger.warn(`DM to ${discordId} failed: ${errorText(error)}`);
          userManager.markDmFailed(discordId, now());
        }
      }
      return { notified, dmFailures };
    },
  };
}
