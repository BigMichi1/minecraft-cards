import type { CollectionId } from './ids';

/** One card set the bot watches: its own catalog, shops and wanted lists. */
export interface CollectionDefinition {
  readonly id: CollectionId;
  /** Display name in commands and alerts. */
  readonly name: string;
}
