CREATE TABLE `customer_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`event` text NOT NULL,
	`state` text NOT NULL,
	`code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_id`) REFERENCES `order_drafts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_notices_uq` ON `customer_notices` (`draft_id`,`event`);--> statement-breakpoint
CREATE INDEX `customer_notices_state_idx` ON `customer_notices` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `customer_notices_shop_idx` ON `customer_notices` (`shop_id`,`draft_id`);