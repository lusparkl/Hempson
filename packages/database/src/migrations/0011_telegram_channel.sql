CREATE TABLE `telegram_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`bot_username` text,
	`webhook_id` text NOT NULL,
	`webhook_auth_hash` text NOT NULL,
	`status` text NOT NULL,
	`last_error` text,
	`connected_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tg_channel_shop_uq` ON `telegram_channels` (`shop_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tg_channel_bot_uq` ON `telegram_channels` (`bot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tg_channel_webhook_uq` ON `telegram_channels` (`webhook_id`);