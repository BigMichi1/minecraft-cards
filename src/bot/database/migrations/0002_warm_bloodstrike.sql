ALTER TABLE `listings` ADD `match_checked_at` integer;--> statement-breakpoint
ALTER TABLE `listings` ADD `id_conflict` integer DEFAULT false NOT NULL;