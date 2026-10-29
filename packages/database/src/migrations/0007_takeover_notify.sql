CREATE TABLE `shop_notify_settings` (
	`shop_id` text PRIMARY KEY NOT NULL,
	`telegram_chat_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `shop_conversations` ADD `ai_paused` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `shop_conversations` ADD `ai_paused_at` text;--> statement-breakpoint
ALTER TABLE `shop_conversations` ADD `ai_paused_by_user_id` text REFERENCES users(id);