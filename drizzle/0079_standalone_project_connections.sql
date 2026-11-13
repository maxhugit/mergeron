ALTER TABLE `project_connections` ADD `agent_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `project_locations` ADD `declared` integer DEFAULT true NOT NULL;
--> statement-breakpoint
-- Preserve existing Git agent workflows; non-Git access remains explicitly opt-in.
UPDATE project_connections SET agent_enabled = 1 WHERE protocol = 'git';
