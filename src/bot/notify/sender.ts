import {
  DiscordAPIError,
  HTTPError,
  RESTJSONErrorCodes,
  type MessageCreateOptions,
} from 'discord.js';
import type { AlertFn } from '../check/adminAlert';
import type { NotificationSender } from '../check/runner';
import {
  listingManager,
  type PendingNotification,
  type PendingNotifications,
} from '../database/listingManager';
import { userManager } from '../database/userManager';
import { errorMessage } from '../utils/async';
import logger, { logError } from '../utils/logger';
import { downloadImage } from '../matcher/embedder';
import { buildNotificationMessages, ITEMS_PER_MESSAGE, type NotificationMessage } from './messages';
import { attachPictures, PictureRun, type DownloadFn } from './pictures';

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
  /** Throttled admin alert for failures that are not one user's closed DMs; its outcome is not used. */
  alert: (...args: Parameters<AlertFn>) => Promise<unknown>;
  /** Downloads a listing or reference picture to attach; the bounded matcher download by default. */
  downloadImage?: DownloadFn;
}

const PAUSE_MS = 500;
/** A first list can match hundreds of listings; the rest arrive in later runs. */
export const MAX_MESSAGES_PER_RUN = 5;
const MAX_ITEMS_PER_RUN = MAX_MESSAGES_PER_RUN * ITEMS_PER_MESSAGE;

function heldBackText(count: number): string {
  return `…and ${count} more listings will follow in the next checks.`;
}

/** Discord's answer when a user does not accept DMs from the bot; the only "DMs closed" case. */
export function isDmClosed(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    error.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser
  );
}

/**
 * Discord refused the payload itself (400 or 413, e.g. 40005 too large, 50035 invalid form
 * body, 50045 file too large), not the user: closed DMs (50007) and 5xx are not this.
 */
export function isPayloadRejection(error: unknown): boolean {
  if (isDmClosed(error)) return false;
  return (
    (error instanceof DiscordAPIError || error instanceof HTTPError) &&
    (error.status === 400 || error.status === 413)
  );
}

type UserOutcome = 'sent' | 'dm-closed' | 'failed' | 'interrupted';

/**
 * Sends each user's pending notifications as DMs and records each one sent.
 * - DMs closed (Discord error 50007): the user is marked (they get a notice on their next
 *   command) and counted in `dmFailures`; their items stay unrecorded.
 * - Any other send failure: logged at error, items unrecorded (retried next run), not marked.
 * - Every attempted user failing (two or more users, or any failure that is not closed DMs)
 *   alerts the admin, as does a message that cannot be built.
 */
export function createDiscordSender(client: DmClient, options: SenderOptions): NotificationSender {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const isShuttingDown = options.isShuttingDown ?? (() => false);
  const { alert } = options;
  const download: DownloadFn =
    options.downloadImage ?? ((url, maxBytes) => downloadImage(url, fetch, maxBytes));

  return {
    async send(pending: PendingNotifications) {
      let notified = 0;
      let dmFailures = 0;
      let first = true;
      const outcomes: UserOutcome[] = [];
      let firstError: string | undefined;
      const pictures = new PictureRun(download);

      for (const [discordId, items] of pending) {
        let messages: NotificationMessage<PendingNotification>[];
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
          logError(`building notifications for ${discordId} failed`, error);
          await alert(
            'notify-build-error',
            `Building notifications failed: ${errorMessage(error)} (see the log)`
          );
          continue;
        }

        let outcome: UserOutcome = 'sent';
        try {
          const user = await client.users.fetch(discordId);
          for (const { message, items: sent } of messages) {
            if (!first) await sleep(PAUSE_MS);
            first = false;
            // attachPictures never rejects: a picture it cannot attach keeps its URL.
            const withPictures = isShuttingDown()
              ? message
              : await attachPictures(message, pictures);
            try {
              await user.send(withPictures);
            } catch (error) {
              if (withPictures === message || isShuttingDown() || !isPayloadRejection(error)) {
                throw error;
              }
              // The pictures may be what Discord refused: the alert itself must still go out.
              logger.warn(
                `DM to ${discordId} with pictures rejected, sending without: ${errorMessage(error)}`
              );
              let plainError: unknown;
              try {
                await user.send(message);
              } catch (retryError) {
                plainError = retryError;
              }
              await alert(
                'notify-attachment-rejected',
                `Discord rejected a notification with attached pictures (${errorMessage(error)}); ` +
                  (plainError === undefined
                    ? 'sent it without them.'
                    : `sending it without them failed too: ${errorMessage(plainError)}`)
              );
              if (plainError !== undefined) throw plainError;
            }
            try {
              for (const item of sent) {
                listingManager.recordNotified(discordId, item.listing.id, item.availableSince);
                notified++;
              }
            } catch (error) {
              // Sent but not recorded: the next run sends it again. Stop here to not add more.
              logError(`recording notifications for ${discordId} failed`, error);
              break;
            }
          }
        } catch (error) {
          if (isShuttingDown()) {
            // The client is going away; the user's DMs may be fine. Unsent items are retried.
            logger.info(`DM to ${discordId} interrupted by shutdown: ${errorMessage(error)}`);
            outcome = 'interrupted';
          } else if (isDmClosed(error)) {
            outcome = 'dm-closed';
            dmFailures++;
            logger.warn(`DM to ${discordId} failed, DMs closed: ${errorMessage(error)}`);
            try {
              userManager.markDmFailed(discordId, now());
            } catch (markError) {
              logError(`marking the DM failure of ${discordId} failed`, markError);
            }
          } else {
            outcome = 'failed';
            firstError ??= errorMessage(error);
            logError(`DM to ${discordId} failed`, error);
          }
        }
        outcomes.push(outcome);
      }

      const picturesText = pictures.alertText();
      if (picturesText) await alert('notify-pictures', picturesText);

      const attempted = outcomes.filter((o) => o !== 'interrupted');
      const allFailed = attempted.length > 0 && attempted.every((o) => o !== 'sent');
      if (allFailed && (attempted.length > 1 || attempted.includes('failed'))) {
        await alert(
          'dm-all-failed',
          `Every notification DM of this check failed (${attempted.length} users)${firstError ? `: ${firstError}` : ', DMs closed'}.`
        );
      }
      return { notified, dmFailures };
    },
  };
}
