import type { CardId } from '../cards/cardId';
import type { CollectionId } from './ids';

/** One card set the bot watches: its own catalog, shops and wanted lists. */
export interface CollectionDefinition<K extends CollectionId = CollectionId> {
  readonly id: K;
  /** Display name in commands and alerts. */
  readonly name: string;
  /** A checklist (`parseChecklist` form) seeded into an empty catalog at start, if any. */
  readonly starterChecklist?: string;
}

/**
 * Card ids together with the collection they were read in: an id means a card only within its
 * collection (`12` is another card in each), so the two travel as one value.
 */
export interface CollectionCards {
  readonly collection: CollectionId;
  readonly ids: readonly CardId[];
}
