-- Collections (docs/superpowers/specs/2026-11-19-multi-collection-design.md). Hand-edited
-- backfill: every row stored before collections belongs to `lego-minecraft-3`. The copies write
-- that value, and `listings.collection` carries it as the column default, since SQLite cannot
-- add a NOT NULL column without one (the schema declares no default, so new rows name theirs).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_wanted_cards` (
	`discord_id` text NOT NULL,
	`collection` text NOT NULL,
	`card_id` text NOT NULL,
	PRIMARY KEY(`discord_id`, `collection`, `card_id`),
	FOREIGN KEY (`discord_id`) REFERENCES `users`(`discord_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_wanted_cards`("discord_id", "collection", "card_id") SELECT "discord_id", 'lego-minecraft-3', "card_id" FROM `wanted_cards`;--> statement-breakpoint
DROP TABLE `wanted_cards`;--> statement-breakpoint
ALTER TABLE `__new_wanted_cards` RENAME TO `wanted_cards`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_cards` (
	`collection` text NOT NULL,
	`card_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text,
	`reference_image_url` text,
	`puzzle_seen` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`collection`, `card_id`)
);
--> statement-breakpoint
INSERT INTO `__new_cards`("collection", "card_id", "type", "name", "reference_image_url", "puzzle_seen", "updated_at") SELECT 'lego-minecraft-3', "card_id", "type", "name", "reference_image_url", "puzzle_seen", "updated_at" FROM `cards`;--> statement-breakpoint
DROP TABLE `cards`;--> statement-breakpoint
ALTER TABLE `__new_cards` RENAME TO `cards`;--> statement-breakpoint
ALTER TABLE `listings` ADD `collection` text DEFAULT 'lego-minecraft-3' NOT NULL;--> statement-breakpoint
CREATE INDEX `listings_collection_shop_idx` ON `listings` (`collection`,`shop`);