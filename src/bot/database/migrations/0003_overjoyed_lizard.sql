ALTER TABLE `cards` ADD `puzzle` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `listings` ADD `id_source` text DEFAULT 'title' NOT NULL;--> statement-breakpoint
ALTER TABLE `listings` ADD `picture_card_id` text;