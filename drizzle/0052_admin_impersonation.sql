CREATE TABLE `impersonation_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`administrator_id` text NOT NULL,
	`administrator_name` text NOT NULL,
	`person_id` text NOT NULL,
	`person_name` text NOT NULL,
	`action` text NOT NULL,
	`method` text,
	`route` text,
	`created_at` integer NOT NULL
);
