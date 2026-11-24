ALTER TABLE `listings` ADD `rematch_from` text;--> statement-breakpoint
-- laststicker's scans are the references (multi-collection step 2): every listing the admin did not
-- map and that is no bundle is compared once again; its old status, when it was a judgement, is kept
-- to count what changed.
-- sammel-ente's `reference` status is gone: a mapped one is the admin's confirmation.
UPDATE `listings` SET `match_status` = 'confirmed' WHERE `match_status` = 'reference' AND `manual_override` = 1;--> statement-breakpoint
UPDATE `listings` SET `rematch_from` = CASE WHEN `match_status` IN ('pending', 'image_unavailable', 'model_unavailable') THEN NULL ELSE `match_status` END, `match_status` = 'pending', `similarity` = NULL, `match_checked_at` = NULL, `picture_card_id` = NULL WHERE `manual_override` = 0 AND `match_status` <> 'bundle';
