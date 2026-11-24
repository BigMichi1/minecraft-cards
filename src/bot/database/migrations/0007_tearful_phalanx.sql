ALTER TABLE `cards` ADD `shop_image_url` text;--> statement-breakpoint
ALTER TABLE `cards` ADD `laststicker_scan_missing_at` integer;--> statement-breakpoint
-- laststicker cards take their scan as the reference (multi-collection step 2): the sammel-ente
-- picture stored so far becomes the fallback. A manual card keeps the admin's picture.
UPDATE `cards` SET `shop_image_url` = `reference_image_url`, `reference_image_url` = NULL WHERE `source` = 'laststicker';
