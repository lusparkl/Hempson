CREATE TABLE `conversation_reads` (
	`shop_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`last_seen_seq` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`conversation_id`, `user_id`),
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `shop_conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversation_reads_user_idx` ON `conversation_reads` (`shop_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `notification_reads` (
	`shop_id` text NOT NULL,
	`user_id` text NOT NULL,
	`seen_at` text NOT NULL,
	PRIMARY KEY(`shop_id`, `user_id`),
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `customers` ADD `note` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `note_updated_at` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `note_updated_by_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `number` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Existing orders get per-shop numbers in creation order before the unique index exists.
UPDATE `order_drafts` SET `number` = (SELECT `n` FROM (SELECT `id`, row_number() OVER (PARTITION BY `shop_id` ORDER BY `created_at`, `id`) AS `n` FROM `order_drafts`) AS `x` WHERE `x`.`id` = `order_drafts`.`id`);--> statement-breakpoint
-- Existing members start with everything already seen, so the upgrade does not mark old history unread.
INSERT INTO `conversation_reads` (`shop_id`, `conversation_id`, `user_id`, `last_seen_seq`, `updated_at`)
SELECT `c`.`shop_id`, `c`.`id`, `m`.`user_id`, coalesce((SELECT max(`seq`) FROM `shop_messages` WHERE `conversation_id` = `c`.`id`), 0), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `shop_conversations` `c` JOIN `memberships` `m` ON `m`.`shop_id` = `c`.`shop_id`;--> statement-breakpoint
INSERT INTO `notification_reads` (`shop_id`, `user_id`, `seen_at`) SELECT `shop_id`, `user_id`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `memberships`;--> statement-breakpoint
CREATE UNIQUE INDEX `order_drafts_number_uq` ON `order_drafts` (`shop_id`,`number`);