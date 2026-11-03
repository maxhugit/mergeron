ALTER TABLE agent_teams ADD COLUMN launched_by TEXT REFERENCES people(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE TABLE agent_team_profiles (project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE, profiles TEXT NOT NULL, updated_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_agent_team_active_coordinator ON agent_teams(coordinator_thread_id) WHERE origin = 'planned' AND state IN ('preparing','dispatching','running','stopping','unknown','needs_attention');
