CREATE TABLE `product_photo_index` (
	`product_id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`image_url` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`embedding` blob,
	`error` text,
	`indexed_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `photo_index_shop_idx` ON `product_photo_index` (`shop_id`,`status`);--> statement-breakpoint
ALTER TABLE `shops` ADD `storefront_enabled` integer DEFAULT false NOT NULL;