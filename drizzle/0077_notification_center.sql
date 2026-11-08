CREATE TABLE `inbox_notifications` (
 `id` text PRIMARY KEY NOT NULL,
 `person_id` text NOT NULL REFERENCES `people`(`id`) ON DELETE cascade,
 `project_id` text REFERENCES `projects`(`id`) ON DELETE cascade,
 `thread_id` text,
 `kind` text NOT NULL,
 `message` text NOT NULL,
 `event_key` text NOT NULL,
 `read_at` integer,
 `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_person_event` ON `inbox_notifications` (`person_id`,`event_key`);
--> statement-breakpoint
CREATE INDEX `inbox_person_date` ON `inbox_notifications` (`person_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `inbox_preferences` (
 `person_id` text PRIMARY KEY NOT NULL REFERENCES `people`(`id`) ON DELETE cascade,
 `retention_days` integer DEFAULT 7 NOT NULL CONSTRAINT `inbox_retention_range` CHECK (`retention_days` BETWEEN 1 AND 365)
);
