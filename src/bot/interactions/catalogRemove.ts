import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { CardId } from '../cards/cardId';
import type { CollectionId } from '../collections/ids';
import { collectionName } from '../collections/index';
import { catalogManager, type ManualRefusal } from '../database/catalogManager';
import { decodeRemovalId, encodeKeepId, encodeRemoveId } from './buttonIds';
import { replyWithError } from '../utils/interactionReply';
import { logError } from '../utils/logger';
import type { AdminDeps } from './adminActions';

const TTL_MS = 10 * 60_000;
const EXPIRED = 'This removal expired, run the command again.';
/** A manual card the admin asked to remove, waiting for Remove or Keep. */
export interface PendingRemoval {
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
      .setCustomId(encodeRemoveId(token))
      .setLabel('Remove')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(encodeKeepId(token))
      .setLabel('Keep')
      .setStyle(ButtonStyle.Secondary)
  );
}

/** Why a manual-card command was refused, as the admin reads it. */
export function manualRefusal(reason: ManualRefusal, cardId: CardId, inCollection: string): string {
  switch (reason) {
    case 'not_manual':
      return `#${cardId} comes from laststicker; only manual cards can be changed here.`;
    case 'unknown':
      return `No card #${cardId} in ${inCollection}.`;
    case 'exists':
      return `#${cardId} is already in ${inCollection}.`;
    case 'not_listed':
      return `#${cardId} is not on laststicker yet; release it once a sync reports it there.`;
  }
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
  // What happened before a failure, so its message says the right thing.
  let done: string | null = null;
  try {
    if (i.user.id !== adminId) {
      await i.reply({ content: 'Only the bot admin can use this.', flags: MessageFlags.Ephemeral });
      return;
    }
    const decoded = decodeRemovalId(i.customId);
    const entry = decoded ? store.take(decoded.token) : undefined;
    if (!decoded || !entry) {
      await i.update({ content: EXPIRED, components: [] });
      return;
    }
    if (!decoded.remove) {
      done = `#${entry.cardId} was kept`;
      await i.update({ content: `Kept #${entry.cardId}.`, components: [] });
      return;
    }
    const result = catalogManager.removeManual(entry.collection, entry.cardId);
    if (result.ok) done = `#${entry.cardId} was removed`;
    await i.update({
      content: result.ok
        ? `Removed #${entry.cardId}.`
        : manualRefusal(result.reason, entry.cardId, collectionName(entry.collection)),
      components: [],
    });
  } catch (error) {
    logError(`[CATALOG REMOVE] ${i.customId} failed`, error);
    if (done) {
      // The work is done; only the message could not be updated: a plain note, no error embed.
      try {
        await i.reply({
          content: `${done}, but this message could not be updated.`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (noteError) {
        logError('[CATALOG REMOVE] the note about the failed message update failed', noteError);
      }
      return;
    }
    await replyWithError(i, 'Error', 'Removing the card failed. Run the command again.');
  }
}
