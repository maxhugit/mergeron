CREATE TABLE `person_agent_document_views` (
	`person_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`mode` text DEFAULT 'plain' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`person_id`, `thread_id`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
