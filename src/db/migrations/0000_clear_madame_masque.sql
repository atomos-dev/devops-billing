-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE `bill_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bill_id` integer NOT NULL,
	`service` text NOT NULL,
	`region` text,
	`resource_id` text,
	`resource_name` text,
	`usage_category` text DEFAULT 'other',
	`amount` real NOT NULL,
	`usage_quantity` real,
	`usage_unit` text,
	`start_date` text,
	`end_date` text,
	FOREIGN KEY (`bill_id`) REFERENCES `bills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bill_items_dedup` ON `bill_items` (`bill_id`,`service`,`region`,`resource_id`,`usage_unit`);--> statement-breakpoint
CREATE TABLE `bills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`billing_period` text NOT NULL,
	`total_amount` real NOT NULL,
	`fetched_at` text DEFAULT (datetime('now')) NOT NULL,
	`raw_data` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bills_provider_period` ON `bills` (`provider`,`billing_period`);--> statement-breakpoint
CREATE TABLE `manual_costs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_name` text NOT NULL,
	`billing_period` text NOT NULL,
	`amount` real NOT NULL,
	`note` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manual_costs_provider_period` ON `manual_costs` (`provider_name`,`billing_period`);--> statement-breakpoint
CREATE TABLE `resources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`resource_id` text NOT NULL,
	`resource_name` text,
	`resource_type` text,
	`region` text,
	`spec` text,
	`tags` text,
	`usage_category` text DEFAULT 'other',
	`monthly_base_cost` real,
	`status` text DEFAULT 'running',
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resources_provider_rid` ON `resources` (`provider`,`resource_id`);--> statement-breakpoint
CREATE TABLE `sync_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`sync_type` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`finished_at` text,
	`records_synced` integer DEFAULT 0,
	`error_message` text,
	`details` text
);
--> statement-breakpoint
CREATE TABLE `provider_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`display_name` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`credentials` text,
	`last_tested_at` text,
	`last_test_result` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_settings_provider_unique` ON `provider_settings` (`provider`);--> statement-breakpoint
CREATE TABLE `bandwidth_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`resource_id` text NOT NULL,
	`region` text,
	`date` text NOT NULL,
	`public_in_gib` real DEFAULT 0 NOT NULL,
	`public_out_gib` real DEFAULT 0 NOT NULL,
	`private_in_gib` real DEFAULT 0 NOT NULL,
	`private_out_gib` real DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bandwidth_usage_dedup` ON `bandwidth_usage` (`provider`,`resource_id`,`date`);
*/