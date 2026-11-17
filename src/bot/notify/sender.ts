import type { MessageCreateOptions } from 'discord.js';
import type { NotificationSender, PendingNotifications } from '../check/runner';
import { listingManager } from '../database/listingManager';
import { userManager } from '../database/userManager';
import logger from '../utils/logger';
import { buildNotificationMessages, type NotificationMessage } from './messages';

/** The only part of the Discord client the sender needs. */
export interface DmClient {
  users: {
    fetch(id: string): Promise<{ send(options: MessageCreateOptions): Promise<unknown> }>;
  };
}

export interface SenderOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const PAUSE_MS = 500;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDiscordSender(
  client: DmClient,
  options: SenderOptions = {}
): NotificationSender {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;

  return {
    async send(pending: PendingNotifications) {
      let notified = 0;
      let dmFailures = 0;
      let first = true;
      for (const [discordId, items] of pending) {
        let messages: NotificationMessage[];
        try {
          messages = buildNotificationMessages(items);
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
          dmFailures++;
          logger.warn(`DM to ${discordId} failed: ${errorText(error)}`);
          userManager.markDmFailed(discordId, now());
        }
      }
      return { notified, dmFailures };
    },
  };
}
