CREATE TABLE `deliverable_document_label_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`deliverable_id` text NOT NULL,
	`document_id` text,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`fingerprint` text NOT NULL,
	`result` text,
	`error` text,
	`actor_id` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`deliverable_id`) REFERENCES `project_deliverables`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `project_deliverable_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_document_label_jobs_deliverable` ON `deliverable_document_label_jobs` (`deliverable_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `deliverable_document_organizations` (
	`deliverable_id` text PRIMARY KEY NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`assignments` text DEFAULT '{}' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`automatic_actor_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`deliverable_id`) REFERENCES `project_deliverables`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`automatic_actor_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
