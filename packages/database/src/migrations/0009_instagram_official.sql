CREATE TABLE `instagram_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`ig_user_id` text NOT NULL,
	`username` text,
	`status` text NOT NULL,
	`token_expires_at` text,
	`token_refreshed_at` text,
	`last_error` text,
	`connected_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ig_channel_shop_uq` ON `instagram_channels` (`shop_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ig_channel_user_uq` ON `instagram_channels` (`ig_user_id`);--> statement-breakpoint
CREATE TABLE `instagram_oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ig_state_exp_idx` ON `instagram_oauth_states` (`expires_at`);--> statement-breakpoint
CREATE TABLE `shop_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`key_version` integer NOT NULL,
	`wrapped_key` text NOT NULL,
	`wrap_nonce` text NOT NULL,
	`wrap_tag` text NOT NULL,
	`nonce` text NOT NULL,
	`ciphertext` text NOT NULL,
	`tag` text NOT NULL,
	`created_at` text NOT NULL,
	`rotated_at` text,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_cred_shop_kind_uq` ON `shop_credentials` (`shop_id`,`kind`);--> statement-breakpoint
CREATE INDEX `shop_cred_version_idx` ON `shop_credentials` (`key_version`);