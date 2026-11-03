CREATE TABLE `agent_teams` (
 `id` text PRIMARY KEY NOT NULL,
 `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
 `coordinator_thread_id` text NOT NULL,
 `request_id` text NOT NULL,
 `fingerprint` text NOT NULL,
 `objective` text NOT NULL,
 `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_team_request` ON `agent_teams` (`project_id`,`coordinator_thread_id`,`request_id`);
--> statement-breakpoint
CREATE TABLE `agent_team_assignments` (
 `id` text PRIMARY KEY NOT NULL,
 `team_id` text NOT NULL REFERENCES `agent_teams`(`id`) ON DELETE CASCADE,
 `role` text NOT NULL,
 `instructions` text NOT NULL,
 `dependencies` text NOT NULL,
 `native_thread_id` text UNIQUE,
 `status` text NOT NULL,
 `result` text,
 `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_team_assignments_team` ON `agent_team_assignments` (`team_id`);
