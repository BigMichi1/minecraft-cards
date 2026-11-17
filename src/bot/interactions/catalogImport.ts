import { MessageFlags } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { CardId } from '../cards/cardId';
import { catalogManager, type ImportPreview } from '../database/catalogManager';
import { replyWithError } from '../utils/interactionReply';
import { errorMessage } from '../utils/async';
import logger, { logError } from '../utils/logger';
import { joinWithinLimit } from '../utils/messageLimit';

const TTL_MS = 10 * 60_000;
const EXPIRED = 'This import expired, run the command again.';

export interface ImportStore {
  put(ids: CardId[]): string;
  /** The pending ids, without consuming the token; undefined when unknown or expired. */
  peek(token: string): CardId[] | undefined;
  /** Returns the pending ids once; the token is consumed. */
  take(token: string): CardId[] | undefined;
}

export function createImportStore(now: () => number): ImportStore {
  const pending = new Map<string, { ids: CardId[]; expiresAt: number }>();
  return {
    put(ids) {
      const t = now();
      for (const [key, entry] of pending) if (entry.expiresAt <= t) pending.delete(key);
      const token = crypto.randomUUID();
      pending.set(token, { ids, expiresAt: t + TTL_MS });
      return token;
    },
    peek(token) {
      const entry = pending.get(token);
      return entry && entry.expiresAt > now() ? entry.ids : undefined;
    },
    take(token) {
      const entry = pending.get(token);
      if (!entry) return undefined;
      pending.delete(token);
      return entry.expiresAt > now() ? entry.ids : undefined;
    },
  };
}

export const importStore = createImportStore(Date.now);

export function buildPreviewText(preview: ImportPreview): string {
  const { counts, added, removed, removedStillWanted } = preview;
  const lines = [
    `Catalog: ${counts.base} base, ${counts.le} LE, ${counts.xxl} XXL.`,
    joinWithinLimit('Added: ', added.length > 0 ? added : ['none'], 600),
    joinWithinLimit('Removed: ', removed.length > 0 ? removed : ['none'], 600),
  ];
  if (removedStillWanted.length > 0) {
    lines.push(
      joinWithinLimit(
        "Still on someone's list: ",
        removedStillWanted.map(
          (r) => `${r.cardId} (${r.users} ${r.users === 1 ? 'user' : 'users'})`
        ),
        500
      )
    );
  }
  return lines.join('\n');
}

/** Handle `catalog-save:<token>` / `catalog-cancel:<token>`; only the admin may press them. */
export async function handleCatalogButton(
  i: ButtonInteraction,
  { adminId }: { adminId: string },
  store: ImportStore = importStore
): Promise<void> {
  try {
    if (i.user.id !== adminId) {
      await i.reply({ content: 'Only the bot admin can use this.', flags: MessageFlags.Ephemeral });
      return;
    }
    const sep = i.customId.indexOf(':');
    const action = i.customId.slice(0, sep);
    const token = i.customId.slice(sep + 1);
    const ids = store.peek(token);
    if (!ids) {
      store.take(token);
      await i.update({ content: EXPIRED, components: [] });
      return;
    }
    if (action === 'catalog-save') {
      try {
        catalogManager.applyImport(ids);
      } catch (err) {
        // The token stays: the buttons still work for another try.
        logError('[CATALOG IMPORT] saving failed', err);
        await replyWithError(i, 'Import failed', 'Saving the catalog failed. Press Save again.');
        return;
      }
    }
    store.take(token);
    const saved = action === 'catalog-save';
    try {
      await i.update({ content: saved ? 'Catalog saved.' : 'Import cancelled.', components: [] });
    } catch (err) {
      // The work is done; only the message could not be updated, so do not say it failed:
      // a plain ephemeral note, not the red error embed.
      logError('[CATALOG IMPORT] updating the message failed', err);
      const note = saved
        ? 'The catalog was saved, but this message could not be updated.'
        : 'The import was cancelled, but this message could not be updated.';
      try {
        const payload = { content: note, flags: MessageFlags.Ephemeral } as const;
        // A deferred or already answered interaction cannot be replied to again.
        if (i.deferred || i.replied) await i.followUp(payload);
        else await i.reply(payload);
      } catch (noteErr) {
        logger.warn(
          `[CATALOG IMPORT] the note about the failed message update could not be delivered: ${errorMessage(noteErr)}`
        );
      }
    }
  } catch (err) {
    logError('[CATALOG IMPORT] button failed', err);
    await replyWithError(i, 'Import failed', 'Something went wrong. Please try again later.');
  }
}
