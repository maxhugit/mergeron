ALTER TABLE `agent_teams` ADD `state` text DEFAULT 'observed' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_teams` ADD `coordinator_status` text;
--> statement-breakpoint
ALTER TABLE `agent_teams` ADD `stop_requested_at` integer;
--> statement-breakpoint
ALTER TABLE `agent_teams` ADD `stop_person_id` text REFERENCES `people`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `agent_teams` ADD `last_error` text;
--> statement-breakpoint
ALTER TABLE `agent_teams` ADD `summary` text;
--> statement-breakpoint
ALTER TABLE `agent_team_assignments` ADD `native_turn_id` text;
