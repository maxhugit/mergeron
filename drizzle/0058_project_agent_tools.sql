CREATE TABLE `project_agent_tool_requests` (
	`project_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`request_id` text NOT NULL,
	`digest` text NOT NULL,
	`person_id` text,
	`result` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `thread_id`, `request_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
