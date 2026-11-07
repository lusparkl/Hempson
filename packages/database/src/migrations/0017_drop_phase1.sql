-- Phase 1 browser connector removed (D41). Only admin keys (account_id IS NULL) survive: an account-scoped key must never become an admin key.
CREATE TABLE `__new_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hashed_key` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
INSERT INTO `__new_api_keys`("id", "name", "hashed_key", "created_at", "revoked_at") SELECT "id", "name", "hashed_key", "created_at", "revoked_at" FROM `api_keys` WHERE "account_id" IS NULL;--> statement-breakpoint
DROP TABLE `api_keys`;--> statement-breakpoint
ALTER TABLE `__new_api_keys` RENAME TO `api_keys`;--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_uq` ON `api_keys` (`hashed_key`);--> statement-breakpoint
DROP TABLE `outbox`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
DROP TABLE `connector_state`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
DROP TABLE `store_accounts`;
