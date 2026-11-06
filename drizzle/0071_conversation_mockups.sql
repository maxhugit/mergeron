CREATE TABLE `conversation_mockup_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`mockup_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`html` text NOT NULL,
	`bytes` integer NOT NULL,
	`author_person_id` text,
	`author_name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mockup_id`) REFERENCES `conversation_mockups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_mockup_revision_number` ON `conversation_mockup_revisions` (`mockup_id`,`number`);--> statement-breakpoint
CREATE TABLE `conversation_mockups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`current_revision` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `project_agent_threads`(`thread_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mockups_conversation` ON `conversation_mockups` (`project_id`,`thread_id`);