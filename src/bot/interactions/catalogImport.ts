import { MessageFlags } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { CardId } from '../cards/cardId';
import type { CollectionId } from '../collections/ids';
import { collectionName } from '../collections/index';
import type { CollectionCards } from '../collections/types';
import { catalogManager, type ImportPreview } from '../database/catalogManager';
import { replyWithError } from '../utils/interactionReply';
import { errorMessage } from '../utils/async';
import logger, { logError } from '../utils/logger';
import type { AdminDeps } from './adminActions';
import { joinWithinLimit } from '../utils/messageLimit';

const TTL_MS = 10 * 60_000;
const EXPIRED = 'This import expired, run the command again.';

/** A previewed import: the collection and the card ids to save. */
export type PendingImport = CollectionCards;

type Entry = PendingImport & { readonly expiresAt: number };

export interface ImportStore {
  put(collection: CollectionId, ids: readonly CardId[]): string;
  /** The pending import, without consuming the token; undefined when unknown or expired. */
  peek(token: string): PendingImport | undefined;
  /** Returns the pending import once; the token is consumed. */
  take(token: string): PendingImport | undefined;
}

export function createImportStore(now: () => number): ImportStore {
  const pending = new Map<string, Entry>();
  const unexpired = (entry: Entry): PendingImport | undefined =>
    entry.expiresAt > now() ? { collection: entry.collection, ids: entry.ids } : undefined;
  return {
    put(collection, ids) {
      const t = now();
      for (const [key, entry] of pending) if (entry.expiresAt <= t) pending.delete(key);
      const token = crypto.randomUUID();
      pending.set(token, { collection, ids, expiresAt: t + TTL_MS });
      return token;
    },
    peek(token) {
      const entry = pending.get(token);
      return entry ? unexpired(entry) : undefined;
    },
    take(token) {
      const entry = pending.get(token);
      if (!entry) return undefined;
      pending.delete(token);
      return unexpired(entry);
    },
  };
}

export const importStore = createImportStore(Date.now);

export function buildPreviewText(collection: CollectionId, preview: ImportPreview): string {
  const { counts, added, removed, removedStillWanted } = preview;
  const lines = [
    `Collection: ${collectionName(collection)}`,
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
  { adminId }: AdminDeps,
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
    const entry = store.peek(token);
    if (!entry) {
      store.take(token);
      await i.update({ content: EXPIRED, components: [] });
      return;
    }
    if (action === 'catalog-save') {
      try {
        catalogManager.applyImport(entry);
      } catch (err) {
        // The token stays: the buttons still work for another try.
        logError(`[CATALOG IMPORT] saving ${entry.collection} failed`, err);
        await replyWithError(i, 'Import failed', 'Saving the catalog failed. Press Save again.');
        return;
      }
    }
    store.take(token);
    const saved = action === 'catalog-save';
    try {
      await i.update({
        content: saved
          ? `Catalog of ${collectionName(entry.collection)} saved.`
          : 'Import cancelled.',
        components: [],
      });
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
