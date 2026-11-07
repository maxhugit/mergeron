CREATE TABLE `project_agent_launches` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`target_key` text NOT NULL,
	`task_id` text,
	`project_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`request_id` text NOT NULL,
	`context` text NOT NULL,
	`state` text NOT NULL,
	`phase` text NOT NULL,
	`thread_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `project_tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `project_resources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_agent_launches_scope_unique` ON `project_agent_launches` (`scope`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_agent_launches_task` ON `project_agent_launches` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_agent_launches_unresolved` ON `project_agent_launches` (`project_id`,`target_key`) WHERE "project_agent_launches"."state" in ('pending', 'needs_attention');--> statement-breakpoint
CREATE INDEX `idx_project_agent_launches_scope` ON `project_agent_launches` (`project_id`,`resource_id`);--> statement-breakpoint
CREATE INDEX `idx_project_agent_launches_thread` ON `project_agent_launches` (`thread_id`);--> statement-breakpoint
INSERT INTO `project_agent_launches` (`id`, `scope`, `target_key`, `task_id`, `project_id`, `resource_id`, `owner_id`, `request_id`, `context`, `state`, `phase`, `thread_id`, `created_at`, `updated_at`)
SELECT l.task_id, 'task:' || l.task_id, 'task:' || l.task_id, l.task_id, l.project_id, t.resource_id, l.owner_id, l.request_id,
  json_object('kind', 'task', 'targetId', t.id, 'targetRevision', t.updated_at,
    'cwd', coalesce(t.workspace_path, ''), 'title', t.title, 'taskId', t.id,
    'createdSubtask', json('false'), 'existing', json('false')),
  CASE WHEN l.state = 'submitted' THEN 'submitted' ELSE 'needs_attention' END,
  'legacy', l.thread_id, l.updated_at, l.updated_at
FROM `project_task_launches` l JOIN `project_tasks` t ON t.id = l.task_id;
--> statement-breakpoint
DROP TABLE `project_task_launches`;