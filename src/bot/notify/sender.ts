import type { MessageCreateOptions } from 'discord.js';
import type { NotificationSender, PendingNotifications } from '../check/runner';
import { listingManager } from '../database/listingManager';
import { userManager } from '../database/userManager';
import logger from '../utils/logger';
import { buildNotificationMessages } from './messages';

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
const ITEMS_PER_MESSAGE = 5;

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
        const messages = buildNotificationMessages(items);
        try {
          const user = await client.users.fetch(discordId);
          for (const [index, message] of messages.entries()) {
            if (!first) await sleep(PAUSE_MS);
            first = false;
            await user.send(message);
            const sent = items.slice(index * ITEMS_PER_MESSAGE, (index + 1) * ITEMS_PER_MESSAGE);
            for (const { listing } of sent) {
              listingManager.recordNotified(discordId, listing.id, listing.availableSince ?? now());
              notified++;
            }
          }
        } catch (error) {
          dmFailures++;
          logger.warn(
            `DM to ${discordId} failed: ${error instanceof Error ? error.message : String(error)}`
          );
          userManager.markDmFailed(discordId, now());
        }
      }
      return { notified, dmFailures };
    },
  };
}
