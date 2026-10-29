CREATE TABLE `agent_preview_recipes` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`encrypted_recipe` text NOT NULL,
	`revision` text NOT NULL,
	`policy_revision` text NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
