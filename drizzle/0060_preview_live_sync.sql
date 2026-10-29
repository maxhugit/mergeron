ALTER TABLE `agent_previews` ADD `thread_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_previews` ADD `source_fingerprint` text;--> statement-breakpoint
ALTER TABLE `agent_previews` ADD `owner_person_id` text;