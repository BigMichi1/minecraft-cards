-- laststicker catalog (docs/superpowers/plans/2026-11-24-collections-pr2a-laststicker-catalog.md).
-- Hand-edited: the last statement marks every stored "Puzzlekarte" name (sammel-ente's) as a
-- puzzle card, because the puzzle flag no longer reads the name and laststicker renames those
-- cards ("The Overworld 1").
CREATE TABLE `catalog_syncs` (
	`collection` text PRIMARY KEY NOT NULL,
	`attempted_at` integer NOT NULL,
	`succeeded_at` integer
);
--> statement-breakpoint
ALTER TABLE `cards` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `cards` ADD `variant` text;--> statement-breakpoint
ALTER TABLE `cards` ADD `source` text DEFAULT 'laststicker' NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `laststicker_image_url` text;--> statement-breakpoint
ALTER TABLE `cards` ADD `listed_noted_at` integer;--> statement-breakpoint
UPDATE `cards` SET `puzzle_seen` = 1 WHERE `name` LIKE '%Puzzlekarte%';
