CREATE TABLE `push_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`event_key` text NOT NULL,
	`thread_id` text,
	`request_instance_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_at` integer,
	FOREIGN KEY (`subscription_id`) REFERENCES `push_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_push_event_device` ON `push_deliveries` (`subscription_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `idx_push_due` ON `push_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `push_events` (
	`event_key` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`endpoint_secret` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth_secret` text NOT NULL,
	`label` text NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`completed` integer DEFAULT true NOT NULL,
	`approvals` integer DEFAULT true NOT NULL,
	`questions` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_test_at` integer,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_secret_unique` ON `push_subscriptions` (`endpoint_secret`);--> statement-breakpoint
CREATE INDEX `idx_push_person` ON `push_subscriptions` (`person_id`);