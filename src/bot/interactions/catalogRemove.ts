import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { CardId } from '../cards/cardId';
import type { CollectionId } from '../collections/ids';
import { collectionName } from '../collections/index';
import { catalogManager, type ManualResult } from '../database/catalogManager';
import { replyWithError } from '../utils/interactionReply';
import { logError } from '../utils/logger';
import type { AdminDeps } from './adminActions';

const TTL_MS = 10 * 60_000;
const EXPIRED = 'This removal expired, run the command again.';
export const REMOVE_PREFIX = 'catalog-remove:';
export const KEEP_PREFIX = 'catalog-keep:';

/** A manual card the admin asked to remove, waiting for Remove or Keep. */
interface PendingRemoval {
  readonly collection: CollectionId;
  readonly cardId: CardId;
}

export interface RemoveStore {
  put(collection: CollectionId, cardId: CardId): string;
  /** The pending removal once; the token is consumed. Undefined when unknown or expired. */
  take(token: string): PendingRemoval | undefined;
}

export function createRemoveStore(now: () => number): RemoveStore {
  const pending = new Map<string, PendingRemoval & { readonly expiresAt: number }>();
  return {
    put(collection, cardId) {
      const t = now();
      for (const [key, entry] of pending) if (entry.expiresAt <= t) pending.delete(key);
      const token = crypto.randomUUID();
      pending.set(token, { collection, cardId, expiresAt: t + TTL_MS });
      return token;
    },
    take(token) {
      const entry = pending.get(token);
      if (!entry) return undefined;
      pending.delete(token);
      return entry.expiresAt > now()
        ? { collection: entry.collection, cardId: entry.cardId }
        : undefined;
    },
  };
}

export const removeStore = createRemoveStore(Date.now);

/** Remove (danger) and Keep for a pending removal. */
export function removeRow(token: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${REMOVE_PREFIX}${token}`)
      .setLabel('Remove')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${KEEP_PREFIX}${token}`)
      .setLabel('Keep')
      .setStyle(ButtonStyle.Secondary)
  );
}

/** Why a manual-card change was refused, as the admin reads it. */
export function manualRefusal(
  result: Exclude<ManualResult, { ok: true }>,
  cardId: CardId,
  inCollection: string
): string {
  return result.reason === 'not_manual'
    ? `#${cardId} comes from laststicker; only manual cards can be changed here.`
    : `No card #${cardId} in ${inCollection}.`;
}

/**
 * Handle `catalog-remove:<token>` / `catalog-keep:<token>`; only the admin may press them. The
 * token is taken before anything is removed, so a second press removes nothing.
 */
export async function handleCatalogRemove(
  i: ButtonInteraction,
  { adminId }: AdminDeps,
  store: RemoveStore = removeStore
): Promise<void> {
  try {
    if (i.user.id !== adminId) {
      await i.reply({ content: 'Only the bot admin can use this.', flags: MessageFlags.Ephemeral });
      return;
    }
    const remove = i.customId.startsWith(REMOVE_PREFIX);
    const token = i.customId.slice((remove ? REMOVE_PREFIX : KEEP_PREFIX).length);
    const entry = store.take(token);
    if (!entry) {
      await i.update({ content: EXPIRED, components: [] });
      return;
    }
    if (!remove) {
      await i.update({ content: `Kept #${entry.cardId}.`, components: [] });
      return;
    }
    const result = catalogManager.removeManual(entry.collection, entry.cardId);
    await i.update({
      content: result.ok
        ? `Removed #${entry.cardId}.`
        : manualRefusal(result, entry.cardId, collectionName(entry.collection)),
      components: [],
    });
  } catch (error) {
    logError(`[CATALOG REMOVE] ${i.customId} failed`, error);
    await replyWithError(i, 'Error', 'Removing the card failed. Run the command again.');
  }
}
