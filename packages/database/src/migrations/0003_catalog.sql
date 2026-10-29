CREATE TABLE `product_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`product_id` text NOT NULL,
	`sku` text NOT NULL,
	`options` text NOT NULL,
	`price_minor` integer,
	`stock` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "variants_stock_nonneg" CHECK("product_variants"."stock" >= 0),
	CONSTRAINT "variants_price_nonneg" CHECK("product_variants"."price_minor" is null or "product_variants"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variants_shop_sku_uq` ON `product_variants` (`shop_id`,`sku`);--> statement-breakpoint
CREATE INDEX `variants_product_idx` ON `product_variants` (`product_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`price_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`media` text NOT NULL,
	`search_text` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "products_price_nonneg" CHECK("products"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX `products_shop_idx` ON `products` (`shop_id`,`created_at`);