CREATE TABLE `project_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`protocol` text NOT NULL,
	`address` text,
	`enabled` integer NOT NULL,
	`connection_state` text NOT NULL,
	`last_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `project_workspace_resources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_connections_protocol" CHECK("project_connections"."protocol" IN ('git', 'ssh', 'sftp', 'ftp', 'ftps'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_connections_id_project` ON `project_connections` (`id`,`project_id`);--> statement-breakpoint
CREATE INDEX `idx_project_connections_project` ON `project_connections` (`project_id`);--> statement-breakpoint
CREATE TABLE `project_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`local_workspace_id` text,
	`connection_id` text,
	`legacy_resource_id` text,
	`access_mode` text NOT NULL,
	`capabilities` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`legacy_resource_id`) REFERENCES `project_workspace_resources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`,`project_id`) REFERENCES `project_connections`(`id`,`project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`local_workspace_id`,`project_id`) REFERENCES `project_workspaces`(`id`,`project_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_locations_kind" CHECK(("project_locations"."kind" IN ('managed_local', 'attached_local') AND "project_locations"."local_workspace_id" IS NOT NULL AND "project_locations"."connection_id" IS NULL AND "project_locations"."legacy_resource_id" IS NULL) OR ("project_locations"."kind" = 'remote' AND "project_locations"."local_workspace_id" IS NULL AND "project_locations"."connection_id" IS NOT NULL)),
	CONSTRAINT "project_locations_access" CHECK("project_locations"."access_mode" IN ('read_only', 'read_write'))
);
--> statement-breakpoint
CREATE INDEX `idx_project_locations_project` ON `project_locations` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_project_locations_connection` ON `project_locations` (`connection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_locations_workspace` ON `project_locations` (`local_workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_locations_legacy_resource` ON `project_locations` (`legacy_resource_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_locations_managed` ON `project_locations` (`project_id`) WHERE "project_locations"."kind" = 'managed_local';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_workspaces_id_project` ON `project_workspaces` (`id`,`project_id`);

--> statement-breakpoint
-- Expand-only migration: legacy tables remain authoritative for writes.
-- No filesystem operations and no secret copy/re-encryption.
INSERT INTO project_connections
  (id, project_id, name, protocol, address, enabled, connection_state, last_checked_at, created_at, updated_at)
SELECT id, project_id, name, type, address, enabled, connection_state, last_checked_at, created_at, updated_at
FROM project_workspace_resources WHERE type <> 'local';
--> statement-breakpoint
INSERT INTO project_locations
  (id, project_id, name, kind, path, local_workspace_id, access_mode, capabilities, created_at, updated_at)
SELECT 'local:' || id, project_id, name,
  CASE WHEN is_primary = 1 THEN 'managed_local' ELSE 'attached_local' END,
  path, id, 'read_write', '{"read":true,"write":true,"execute":false}', created_at, updated_at
FROM project_workspaces;
--> statement-breakpoint
INSERT INTO project_locations
  (id, project_id, name, kind, path, connection_id, legacy_resource_id, access_mode, capabilities, created_at, updated_at)
SELECT 'remote:' || id, project_id, name, 'remote', root_path, id, id,
  access_mode, capabilities, created_at, updated_at
FROM project_workspace_resources WHERE type <> 'local';
--> statement-breakpoint
CREATE TRIGGER project_locations_workspace_insert AFTER INSERT ON project_workspaces BEGIN
INSERT INTO project_locations
  (id, project_id, name, kind, path, local_workspace_id, connection_id, legacy_resource_id, access_mode, capabilities, created_at, updated_at)
VALUES ('local:' || NEW.id, NEW.project_id, NEW.name,
  CASE WHEN NEW.is_primary = 1 THEN 'managed_local' ELSE 'attached_local' END,
  NEW.path, NEW.id, NULL, NULL, 'read_write', '{"read":true,"write":true,"execute":false}', NEW.created_at, NEW.updated_at)
ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, name=excluded.name,
  kind=excluded.kind, path=excluded.path, updated_at=excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER project_locations_resource_insert AFTER INSERT ON project_workspace_resources BEGIN
INSERT INTO project_connections
  (id, project_id, name, protocol, address, enabled, connection_state, last_checked_at, created_at, updated_at)
SELECT NEW.id, NEW.project_id, NEW.name, NEW.type, NEW.address, NEW.enabled,
  NEW.connection_state, NEW.last_checked_at, NEW.created_at, NEW.updated_at
WHERE NEW.type <> 'local'
ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, name=excluded.name,
  protocol=excluded.protocol, address=excluded.address, enabled=excluded.enabled,
  connection_state=excluded.connection_state, last_checked_at=excluded.last_checked_at,
  updated_at=excluded.updated_at;
INSERT INTO project_locations
  (id, project_id, name, kind, path, local_workspace_id, connection_id, legacy_resource_id, access_mode, capabilities, created_at, updated_at)
SELECT 'remote:' || NEW.id, NEW.project_id, NEW.name, 'remote', NEW.root_path,
  NULL, NEW.id, NEW.id, NEW.access_mode, NEW.capabilities, NEW.created_at, NEW.updated_at
WHERE NEW.type <> 'local'
ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, name=excluded.name,
  path=excluded.path, access_mode=excluded.access_mode, capabilities=excluded.capabilities,
  updated_at=excluded.updated_at;
DELETE FROM project_connections WHERE id=NEW.id AND NEW.type='local';
END;
--> statement-breakpoint
CREATE TRIGGER project_locations_workspace_update AFTER UPDATE ON project_workspaces BEGIN
INSERT INTO project_locations
  (id, project_id, name, kind, path, local_workspace_id, connection_id, legacy_resource_id, access_mode, capabilities, created_at, updated_at)
VALUES ('local:' || NEW.id, NEW.project_id, NEW.name,
  CASE WHEN NEW.is_primary = 1 THEN 'managed_local' ELSE 'attached_local' END,
  NEW.path, NEW.id, NULL, NULL, 'read_write', '{"read":true,"write":true,"execute":false}', NEW.created_at, NEW.updated_at)
ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, name=excluded.name,
  kind=excluded.kind, path=excluded.path, updated_at=excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER project_locations_resource_update AFTER UPDATE ON project_workspace_resources BEGIN
INSERT INTO project_connections
  (id, project_id, name, protocol, address, enabled, connection_state, last_checked_at, created_at, updated_at)
SELECT NEW.id, NEW.project_id, NEW.name, NEW.type, NEW.address, NEW.enabled,
  NEW.connection_state, NEW.last_checked_at, NEW.created_at, NEW.updated_at
WHERE NEW.type <> 'local'
ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, name=excluded.name,
  protocol=excluded.protocol, address=excluded.address, enabled=excluded.enabled,
  connection_state=excluded.connection_state, last_checked_at=excluded.last_checked_at,
  updated_at=excluded.updated_at;
INSERT INTO project_locations
  (id, project_id, name, kind, path, local_workspace_id, connection_id, legacy_resource_id, access_mode, capabilities, created_at, updated_at)
SELECT 'remote:' || NEW.id, NEW.project_id, NEW.name, 'remote', NEW.root_path,
  NULL, NEW.id, NEW.id, NEW.access_mode, NEW.capabilities, NEW.created_at, NEW.updated_at
WHERE NEW.type <> 'local'
ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, name=excluded.name,
  path=excluded.path, access_mode=excluded.access_mode, capabilities=excluded.capabilities,
  updated_at=excluded.updated_at;
DELETE FROM project_connections WHERE id=NEW.id AND NEW.type='local';
END;
