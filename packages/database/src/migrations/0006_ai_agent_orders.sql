CREATE TABLE `ai_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`trigger_message_id` text NOT NULL,
	`status` text NOT NULL,
	`model` text,
	`model_requests` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reply_message_id` text,
	`detail` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `shop_conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trigger_message_id`) REFERENCES `shop_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_message_id`) REFERENCES `shop_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_runs_trigger_uq` ON `ai_runs` (`trigger_message_id`);--> statement-breakpoint
CREATE INDEX `ai_runs_shop_idx` ON `ai_runs` (`shop_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `escalations` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text,
	`reason` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by_user_id` text,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `shop_conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `escalations_shop_idx` ON `escalations` (`shop_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `escalations_conv_idx` ON `escalations` (`conversation_id`,`status`);--> statement-breakpoint
CREATE TABLE `order_draft_items` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`sku` text NOT NULL,
	`product_name` text NOT NULL,
	`options` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_minor` integer NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_id`) REFERENCES `order_drafts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_items_qty_pos" CHECK("order_draft_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE INDEX `order_items_draft_idx` ON `order_draft_items` (`draft_id`);--> statement-breakpoint
CREATE TABLE `order_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`run_id` text,
	`contact_name` text,
	`contact_phone` text,
	`delivery_info` text,
	`note` text,
	`currency` text NOT NULL,
	`total_minor` integer NOT NULL,
	`decided_by_user_id` text,
	`decided_at` text,
	`decision_note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `shop_conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_drafts_total_nonneg" CHECK("order_drafts"."total_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX `order_drafts_shop_idx` ON `order_drafts` (`shop_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_drafts_conv_idx` ON `order_drafts` (`conversation_id`,`status`);--> statement-breakpoint
CREATE TABLE `shop_ai_settings` (
	`shop_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
