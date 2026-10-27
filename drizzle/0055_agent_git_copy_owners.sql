CREATE TABLE `project_git_copy_owners` (
	`copy_id` text PRIMARY KEY NOT NULL,
	`agent_thread_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`copy_id`) REFERENCES `project_workspace_copies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_git_copy_owners_agent_thread_id_unique` ON `project_git_copy_owners` (`agent_thread_id`);
--> statement-breakpoint
-- Preserve existing unambiguous assignments; ambiguous shared copies are never
-- arbitrarily assigned, moved or deleted by the migration.
WITH effective_agents AS (
  SELECT coalesce(e.tree_root_thread_id, a.thread_id) AS thread_id, a.project_id,
    CASE WHEN f.context_id IS NULL THEN a.workspace_path
      WHEN w.id IS NULL THEN NULL
      ELSE w.path || CASE WHEN f.relative_path = '' THEN '' ELSE '/' || f.relative_path END
    END AS cwd
  FROM project_agent_threads a
  LEFT JOIN conversation_branch_edges e ON e.child_thread_id = a.thread_id
  LEFT JOIN project_active_folders f ON f.context_type = 'agent' AND f.context_id = a.thread_id
  LEFT JOIN project_workspaces w ON w.id = f.resource_id AND w.project_id = a.project_id
), candidates AS (
  SELECT DISTINCT c.id AS copy_id, a.thread_id, c.project_id
  FROM project_workspace_copies c
  JOIN project_workspaces w ON w.id = c.local_workspace_id
  JOIN effective_agents a ON a.project_id = c.project_id
    AND (a.cwd = w.path OR substr(a.cwd, 1, length(w.path) + 1) = w.path || '/')
)
INSERT INTO project_git_copy_owners (copy_id, agent_thread_id, project_id, created_at)
SELECT c.copy_id, c.thread_id, c.project_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM candidates c
WHERE (SELECT count(*) FROM candidates x WHERE x.copy_id = c.copy_id) = 1
  AND (SELECT count(*) FROM candidates x WHERE x.thread_id = c.thread_id) = 1;
