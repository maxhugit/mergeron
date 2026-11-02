CREATE TABLE `transcription_jobs` (
 `id` text PRIMARY KEY NOT NULL,
 `owner` text NOT NULL,
 `filename` text NOT NULL,
 `source_key` text NOT NULL,
 `state` text NOT NULL,
 `created_at` integer NOT NULL,
 `updated_at` integer NOT NULL,
 `result` text,
 `error` text
);
--> statement-breakpoint
CREATE INDEX `transcription_owner_source` ON `transcription_jobs` (`owner`,`source_key`);
