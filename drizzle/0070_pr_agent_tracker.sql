CREATE TABLE `project_pull_request_agents` (
	`project_id` text NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`thread_id` text NOT NULL,
	`phase` text NOT NULL,
	`turn_id` text,
	`monitor_id` text,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `repository`, `number`, `thread_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `project_agent_threads`(`thread_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `project_pull_requests` (
	`project_id` text NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`creator_thread_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `repository`, `number`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
