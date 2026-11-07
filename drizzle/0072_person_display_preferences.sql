CREATE TABLE `person_display_preferences` (
	`person_id` text PRIMARY KEY NOT NULL,
	`mobile` integer DEFAULT 100 NOT NULL,
	`tablet` integer DEFAULT 100 NOT NULL,
	`desktop` integer DEFAULT 100 NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
