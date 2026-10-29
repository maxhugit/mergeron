CREATE TABLE `agent_previews` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`preview_id` text NOT NULL,
	`run_id` text NOT NULL,
	`request_id` text NOT NULL,
	`source_path` text NOT NULL,
	`source_sha` text,
	`profile_revision` text NOT NULL,
	`state` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_previews_preview_id_unique` ON `agent_previews` (`preview_id`);--> statement-breakpoint
CREATE TABLE `project_preview_profiles` (
	`project_id` text PRIMARY KEY NOT NULL,
	`encrypted_profile` text NOT NULL,
	`revision` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
