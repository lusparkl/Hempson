ALTER TABLE `shop_ai_settings` ADD `operator_stopped_at` text;--> statement-breakpoint
ALTER TABLE `shop_ai_settings` ADD `operator_stop_reason` text;--> statement-breakpoint
CREATE INDEX `ai_runs_created_idx` ON `ai_runs` (`created_at`);