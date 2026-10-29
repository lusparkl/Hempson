CREATE TABLE `web_chat_configs` (
	`shop_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`widget_key` text NOT NULL,
	`allowed_origins` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `web_chat_key_uq` ON `web_chat_configs` (`widget_key`);--> statement-breakpoint
CREATE TABLE `web_chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`visitor_id` text NOT NULL,
	`display_name` text,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `web_chat_session_token_uq` ON `web_chat_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `web_chat_session_shop_idx` ON `web_chat_sessions` (`shop_id`,`expires_at`);