import type { ChatInputCommandInteraction, SlashCommandStringOption } from 'discord.js';
import { isCollectionId, type CollectionId } from '../collections/ids';
import { collectionChoices } from '../collections/index';

/** The reply when a command's collection is not one of the registry's. */
export const UNKNOWN_COLLECTION = 'Unknown collection.';

/**
 * The `collection` option of every card command: required, one choice per collection. Pass it
 * first to `addStringOption`, as Discord wants required options before optional ones.
 */
export function collectionOption(o: SlashCommandStringOption): SlashCommandStringOption {
  return o
    .setName('collection')
    .setDescription('Card collection')
    .setRequired(true)
    .addChoices(...collectionChoices());
}

/**
 * The collection the user chose, or null when the value is missing or not in the registry (a
 * stale client or a crafted interaction); the caller then answers UNKNOWN_COLLECTION.
 */
export function readCollection(i: ChatInputCommandInteraction): CollectionId | null {
  const value = i.options.getString('collection');
  return value !== null && isCollectionId(value) ? value : null;
}
