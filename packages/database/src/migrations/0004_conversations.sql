CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`channel` text NOT NULL,
	`external_id` text NOT NULL,
	`display_name` text,
	`handle` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_shop_channel_ext_uq` ON `customers` (`shop_id`,`channel`,`external_id`);--> statement-breakpoint
CREATE INDEX `customers_shop_idx` ON `customers` (`shop_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `shop_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`channel` text NOT NULL,
	`external_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`last_message_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_conv_shop_channel_ext_uq` ON `shop_conversations` (`shop_id`,`channel`,`external_id`);--> statement-breakpoint
CREATE INDEX `shop_conv_last_idx` ON `shop_conversations` (`shop_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `shop_conv_customer_idx` ON `shop_conversations` (`customer_id`);--> statement-breakpoint
CREATE TABLE `shop_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`external_id` text,
	`direction` text NOT NULL,
	`sender_type` text NOT NULL,
	`sender_user_id` text,
	`text` text,
	`attachments` text NOT NULL,
	`delivery_status` text NOT NULL,
	`delivery_error` text,
	`seq` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `shop_conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shop_msg_sender_dir" CHECK(("shop_messages"."direction" = 'incoming' and "shop_messages"."sender_type" = 'customer') or ("shop_messages"."direction" = 'outgoing' and "shop_messages"."sender_type" <> 'customer')),
	CONSTRAINT "shop_msg_human_user" CHECK("shop_messages"."sender_user_id" is null or "shop_messages"."sender_type" = 'human')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_msg_conv_ext_uq` ON `shop_messages` (`conversation_id`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `shop_msg_conv_seq_uq` ON `shop_messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE INDEX `shop_msg_shop_idx` ON `shop_messages` (`shop_id`,`created_at`);