CREATE TABLE `shops` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`default_currency` text DEFAULT 'UAH' NOT NULL,
	`default_language` text DEFAULT 'uk' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shops_slug_uq` ON `shops` (`slug`);