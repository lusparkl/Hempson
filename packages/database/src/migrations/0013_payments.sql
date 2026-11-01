CREATE TABLE `order_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`provider` text NOT NULL,
	`state` text NOT NULL,
	`active` integer NOT NULL,
	`invoice_id` text,
	`page_url` text,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`provider_modified_at` text,
	`final_amount_minor` integer,
	`provider_err_code` text,
	`flag` text,
	`expires_at` text NOT NULL,
	`link_sent_at` text,
	`link_delivery` text,
	`last_checked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_id`) REFERENCES `order_drafts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_payments_draft_idx` ON `order_payments` (`shop_id`,`draft_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_payments_invoice_uq` ON `order_payments` (`provider`,`invoice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_payments_active_uq` ON `order_payments` (`draft_id`) WHERE "order_payments"."active" = 1;--> statement-breakpoint
CREATE INDEX `order_payments_state_idx` ON `order_payments` (`state`,`last_checked_at`);--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`payment_id` text,
	`provider` text NOT NULL,
	`invoice_id` text NOT NULL,
	`status` text NOT NULL,
	`provider_modified_at` text NOT NULL,
	`amount_minor` integer,
	`ccy` integer,
	`source` text NOT NULL,
	`verdict` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `order_payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_events_uq` ON `payment_events` (`shop_id`,`provider`,`invoice_id`,`status`,`provider_modified_at`);--> statement-breakpoint
CREATE INDEX `payment_events_payment_idx` ON `payment_events` (`payment_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `shop_payment_settings` (
	`shop_id` text PRIMARY KEY NOT NULL,
	`webhook_id` text,
	`merchant_id` text,
	`merchant_name` text,
	`provider_pub_key` text,
	`provider_pub_key_at` text,
	`payment_timeout_hours` integer DEFAULT 24 NOT NULL,
	`reminder_hours_before` integer DEFAULT 6 NOT NULL,
	`last_error` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_payment_settings_webhook_uq` ON `shop_payment_settings` (`webhook_id`);--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `payment_due_at` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `payment_reminder_at` text;