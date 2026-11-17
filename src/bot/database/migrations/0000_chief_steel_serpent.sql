CREATE TABLE `admin_alerts` (
	`key` text PRIMARY KEY NOT NULL,
	`last_sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cards` (
	`card_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text,
	`reference_image_url` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `image_embeddings` (
	`image_url` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`embedding` blob NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `listing_cards` (
	`listing_id` integer NOT NULL,
	`card_id` text NOT NULL,
	PRIMARY KEY(`listing_id`, `card_id`),
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `listings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`shop` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`image_url` text,
	`price_cents` integer,
	`currency` text,
	`format` text NOT NULL,
	`auction_ends_at` integer,
	`available` integer NOT NULL,
	`available_since` integer,
	`match_status` text NOT NULL,
	`similarity` real,
	`on_hold` integer DEFAULT false NOT NULL,
	`manual_override` integer DEFAULT false NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listings_url_unique` ON `listings` (`url`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`discord_id` text NOT NULL,
	`listing_id` integer NOT NULL,
	`available_since` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_discordId_listingId_availableSince_unique` ON `notifications` (`discord_id`,`listing_id`,`available_since`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`reporter_id` text NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`summary` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`discord_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`dm_failed_at` integer
);
--> statement-breakpoint
CREATE TABLE `wanted_cards` (
	`discord_id` text NOT NULL,
	`card_id` text NOT NULL,
	PRIMARY KEY(`discord_id`, `card_id`),
	FOREIGN KEY (`discord_id`) REFERENCES `users`(`discord_id`) ON UPDATE no action ON DELETE cascade
);
