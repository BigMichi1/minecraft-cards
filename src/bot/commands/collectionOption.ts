import type { ChatInputCommandInteraction, SlashCommandStringOption } from 'discord.js';
import { isCollectionId, type CollectionId } from '../collections/ids';
import { COLLECTIONS, collectionChoices, collectionName } from '../collections/index';
import { catalogManager } from '../database/catalogManager';
import logger from '../utils/logger';

/**
 * The reply when a command's collection is missing or not one of the registry's: most likely
 * Discord still shows an older registration of the command.
 */
export const UNKNOWN_COLLECTION = `Unknown collection. Discord may show an outdated command: reopen Discord and pick one of: ${COLLECTIONS.map((c) => c.name).join(', ')}.`;

/**
 * The `collection` option of every card command (`/missing *`, `/stock`, `/card`, `/admin map`,
 * `/admin catalog import`): required, one choice per collection. Add it before any optional
 * option (Discord rejects a required option after an optional one); every command adds it
 * first.
 */
export function collectionOption(o: SlashCommandStringOption): SlashCommandStringOption {
  return o
    .setName('collection')
    .setDescription('Card collection')
    .setRequired(true)
    .addChoices(...collectionChoices());
}

/**
 * The collection the user chose, or null when the value is missing or not in the registry (an
 * outdated command registration, or a crafted interaction); that case is logged, and the caller
 * answers UNKNOWN_COLLECTION.
 */
export function readCollection(i: ChatInputCommandInteraction): CollectionId | null {
  const value = i.options.getString('collection');
  if (value !== null && isCollectionId(value)) return value;
  logger.warn(
    `[COLLECTION] /${i.commandName}: ${value === null ? 'no collection' : `unknown collection ${JSON.stringify(value)}`} (an outdated command?)`
  );
  return null;
}

/**
 * The reply for a collection whose catalog has no card yet (series 1 and 2 before their first
 * laststicker sync), or null: without it every card number would read as unknown.
 */
export function catalogNotLoaded(collection: CollectionId): string | null {
  if (catalogManager.knownIds(collection).size > 0) return null;
  return `The card list of ${collectionName(collection)} is not loaded yet: it comes from laststicker with the next check (/admin catalog sync loads it now).`;
}
