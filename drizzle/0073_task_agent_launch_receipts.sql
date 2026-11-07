CREATE TABLE `project_task_launches` (
	`task_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`request_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`state` text NOT NULL,
	`thread_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `project_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_project_tasks_linked_thread` ON `project_tasks` (`linked_thread_id`);
