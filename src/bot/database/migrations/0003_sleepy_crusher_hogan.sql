ALTER TABLE `listings` ADD `id_source` text DEFAULT 'title' NOT NULL;--> statement-breakpoint
ALTER TABLE `listings` ADD `picture_card_id` text;--> statement-breakpoint
ALTER TABLE `listings` ADD `mismatch_noted_at` integer;--> statement-breakpoint
-- Picture identification (docs/image-matching.md): every listing compared before it goes through
-- the new rules on the next run. The admin's mappings, bundles and references stay as they are.
UPDATE `listings` SET `match_status` = 'pending', `similarity` = NULL, `match_checked_at` = NULL WHERE `manual_override` = 0 AND `match_status` NOT IN ('reference', 'bundle');
