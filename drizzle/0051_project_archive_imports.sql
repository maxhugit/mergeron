CREATE TABLE `project_archive_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_version` text NOT NULL,
	`imported_at` integer NOT NULL,
	`provenance` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_project_archive_imports_project` ON `project_archive_imports` (`project_id`);