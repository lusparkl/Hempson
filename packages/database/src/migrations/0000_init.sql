CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`name` text NOT NULL,
	`hashed_key` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `store_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_uq` ON `api_keys` (`hashed_key`);--> statement-breakpoint
CREATE TABLE `connector_state` (
	`account_id` text PRIMARY KEY NOT NULL,
	`last_sync_at` text,
	`last_error` text,
	`sync_cursor` text,
	`baseline_done` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `store_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text,
	`participants` text NOT NULL,
	`title` text NOT NULL,
	`last_observed_at` text NOT NULL,
	`last_message_at` text,
	`unread` integer,
	FOREIGN KEY (`account_id`) REFERENCES `store_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conv_account_provider_uq` ON `conversations` (`account_id`,`provider_id`);--> statement-breakpoint
CREATE INDEX `conv_account_last_idx` ON `conversations` (`account_id`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` text NOT NULL,
	`sequence` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `store_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_account_seq_uq` ON `events` (`account_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`provider_id` text,
	`fingerprint` text NOT NULL,
	`direction` text NOT NULL,
	`sender_display_name` text,
	`text` text,
	`attachments` text NOT NULL,
	`sent_at` text,
	`observed_at` text NOT NULL,
	`seq` integer NOT NULL,
	`delivery_status` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `store_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `msg_account_fp_uq` ON `messages` (`account_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `msg_conv_idx` ON `messages` (`account_id`,`conversation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`dry_run` integer DEFAULT false NOT NULL,
	`reviewed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `store_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_account_idem_uq` ON `outbox` (`account_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `outbox_status_idx` ON `outbox` (`account_id`,`status`);--> statement-breakpoint
CREATE TABLE `store_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`connector_type` text NOT NULL,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`outbound_enabled` integer DEFAULT false NOT NULL,
	`consent_recorded_at` text,
	`expected_instagram_handle` text,
	`last_auth_validated_at` text,
	`last_error_code` text,
	`paused` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
