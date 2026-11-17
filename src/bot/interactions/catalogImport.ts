import { MessageFlags } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { CardId } from '../cards/cardId';
import { catalogManager, type ImportPreview } from '../database/catalogManager';
import { errorMessage } from '../utils/async';
import { replyWithError } from '../utils/interactionReply';
import logger from '../utils/logger';
import { joinWithinLimit } from '../utils/messageLimit';

const TTL_MS = 10 * 60_000;
const EXPIRED = 'This import expired, run the command again.';

export interface ImportStore {
  put(ids: CardId[]): string;
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
    const ids = store.take(token);
    if (!ids) {
      await i.update({ content: EXPIRED, components: [] });
      return;
    }
    if (action === 'catalog-save') {
      catalogManager.applyImport(ids);
      await i.update({ content: 'Catalog saved.', components: [] });
    } else {
      await i.update({ content: 'Import cancelled.', components: [] });
    }
  } catch (err) {
    logger.error(`[CATALOG IMPORT] button failed: ${errorMessage(err)}`);
    await replyWithError(i, 'Import failed', 'Something went wrong. Please try again later.');
  }
}
