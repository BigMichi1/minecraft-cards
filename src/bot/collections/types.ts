import type { CollectionId } from './ids';

/** One card set the bot watches: its own catalog, shops and wanted lists. */
export interface CollectionDefinition<K extends CollectionId = CollectionId> {
  readonly id: K;
  /** Display name in commands and alerts. */
  readonly name: string;
  /** A checklist (`parseChecklist` form) seeded into an empty catalog at start, if any. */
  readonly starterChecklist?: string;
}
