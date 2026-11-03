ALTER TABLE `transcription_jobs` ADD `operation` text NOT NULL DEFAULT 'transcribe';
--> statement-breakpoint
ALTER TABLE `transcription_jobs` ADD `audio` text;
--> statement-breakpoint
ALTER TABLE `transcription_jobs` ADD `project_id` text;
--> statement-breakpoint
ALTER TABLE `transcription_jobs` ADD `thread_id` text;
--> statement-breakpoint
ALTER TABLE `transcription_jobs` ADD `request_key` text;
--> statement-breakpoint
ALTER TABLE `transcription_jobs` ADD `request_digest` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `transcription_request_key` ON `transcription_jobs` (`request_key`);
