CREATE TABLE `agent_context_events` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`trigger` text NOT NULL,
	`state` text NOT NULL,
	`revision` text,
	`sources` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `project_agent_threads`(`thread_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_context_events_thread` ON `agent_context_events` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_instruction_sources` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`copy_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `project_agent_threads`(`thread_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `person_agent_instructions` (
	`person_id` text PRIMARY KEY NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`language` text DEFAULT 'message' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
