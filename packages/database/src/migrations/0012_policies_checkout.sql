CREATE TABLE `customer_refusals` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`customer_id` text,
	`phone` text,
	`draft_id` text,
	`source` text NOT NULL,
	`created_by_user_id` text,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_id`) REFERENCES `order_drafts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `refusals_shop_phone_idx` ON `customer_refusals` (`shop_id`,`phone`);--> statement-breakpoint
CREATE INDEX `refusals_shop_customer_idx` ON `customer_refusals` (`shop_id`,`customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refusals_draft_uq` ON `customer_refusals` (`draft_id`);--> statement-breakpoint
CREATE TABLE `order_events` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_id`) REFERENCES `order_drafts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_events_draft_idx` ON `order_events` (`draft_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_events_shop_idx` ON `order_events` (`shop_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `shop_delivery_settings` (
	`shop_id` text PRIMARY KEY NOT NULL,
	`sender_ref` text,
	`sender_contact_ref` text,
	`sender_phone` text,
	`sender_city_ref` text,
	`sender_city_name` text,
	`sender_warehouse_ref` text,
	`sender_warehouse_name` text,
	`cod_enabled` integer DEFAULT true NOT NULL,
	`prepaid_enabled` integer DEFAULT false NOT NULL,
	`refusal_limit` integer DEFAULT 1 NOT NULL,
	`parcel_weight_kg` text DEFAULT '1' NOT NULL,
	`parcel_description` text DEFAULT 'Товар' NOT NULL,
	`last_error` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `shop_policies` (
	`shop_id` text NOT NULL,
	`topic` text NOT NULL,
	`text` text NOT NULL,
	`version` integer NOT NULL,
	`updated_by_user_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_policies_uq` ON `shop_policies` (`shop_id`,`topic`);--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `approved_at` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `recipient_first_name` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `recipient_last_name` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `recipient_phone` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `np_city_ref` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `np_city_name` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `np_warehouse_ref` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `np_warehouse_name` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `payment_method` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `ttn_state` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `ttn_error` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `ttn` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `np_document_ref` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `np_status_code` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `np_status_text` text;--> statement-breakpoint
ALTER TABLE `order_drafts` ADD `np_status_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `order_drafts_ttn_uq` ON `order_drafts` (`shop_id`,`ttn`);--> statement-breakpoint
ALTER TABLE `shop_ai_settings` ADD `autonomy` text DEFAULT 'approval_required' NOT NULL;--> statement-breakpoint
ALTER TABLE `shop_ai_settings` ADD `auto_confirm_max_minor` integer;--> statement-breakpoint
ALTER TABLE `shop_ai_settings` ADD `autonomy_changed_at` text;--> statement-breakpoint
ALTER TABLE `shop_ai_settings` ADD `autonomy_changed_by` text REFERENCES users(id);--> statement-breakpoint
UPDATE `order_drafts` SET `approved_at` = `decided_at` WHERE `status` = 'approved';