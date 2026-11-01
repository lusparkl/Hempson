CREATE TABLE `shop_plans` (
	`shop_id` text PRIMARY KEY NOT NULL,
	`plan` text NOT NULL,
	`custom_cap` integer,
	`cap_notice_month` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
