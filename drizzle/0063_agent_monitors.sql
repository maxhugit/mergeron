CREATE TABLE `agent_monitor_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`active_thread_id` text,
	`turn_id` text,
	`status` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`claimed_at` integer NOT NULL,
	`lease_until` integer NOT NULL,
	`finished_at` integer,
	`result` text DEFAULT '' NOT NULL,
	`reason` text,
	`disposition` text DEFAULT 'continue' NOT NULL,
	`changed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `agent_monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_monitor_active_thread` ON `agent_monitor_runs` (`active_thread_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_monitor_runs_history` ON `agent_monitor_runs` (`monitor_id`,`claimed_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_monitor_runs_lease` ON `agent_monitor_runs` (`status`,`lease_until`);--> statement-breakpoint
CREATE TABLE `agent_monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`person_id` text NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`name` text NOT NULL,
	`instructions` text NOT NULL,
	`interval_ms` integer,
	`next_run_at` integer,
	`expires_at` integer NOT NULL,
	`max_runs` integer NOT NULL,
	`max_run_ms` integer NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`access_mode` text DEFAULT 'readOnly' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_reason` text,
	`last_result_digest` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `project_agent_threads`(`thread_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_monitor_limits" CHECK("agent_monitors"."max_runs" BETWEEN 1 AND 100 AND "agent_monitors"."max_run_ms" BETWEEN 30000 AND 1800000 AND "agent_monitors"."run_count" >= 0),
	CONSTRAINT "agent_monitor_interval" CHECK("agent_monitors"."interval_ms" IS NULL OR "agent_monitors"."interval_ms" BETWEEN 60000 AND 2592000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_monitors_request` ON `agent_monitors` (`thread_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_monitors_due` ON `agent_monitors` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_monitors_project` ON `agent_monitors` (`project_id`,`updated_at`);