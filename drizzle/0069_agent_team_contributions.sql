ALTER TABLE agent_teams ADD COLUMN deliverable_id TEXT;
--> statement-breakpoint
ALTER TABLE agent_team_assignments ADD COLUMN task_id TEXT;
--> statement-breakpoint
CREATE INDEX idx_agent_team_deliverable ON agent_teams(project_id, deliverable_id);
--> statement-breakpoint
CREATE INDEX idx_agent_team_task ON agent_team_assignments(task_id);
