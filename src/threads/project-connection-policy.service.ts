/** Builds per-project Codex app and MCP enablement overrides for new threads. */
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import { currentAccess } from '../auth/access-context';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';
import type { JsonValue } from '../codex/codex-schema/serde_json/JsonValue';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectActivity,
  projectAgentThreads,
  projects,
  projectWorkspaceCopies,
  projectWorkspaceResources,
  projectWorkspaces,
} from '../database/schema';

type JsonObject = { [key: string]: JsonValue };

export interface ProjectExecutionPolicy {
  executionCwd?: string;
  projectId: string;
  config: JsonObject;
  model: string | null;
  reasoningEffort: string | null;
  workspaceId: string;
  readOnly: boolean;
  sourceResourceId: string | null;
  sourceRevision: string | null;
}

@Injectable()
export class ProjectConnectionPolicyService {
  constructor(
    private readonly codex: CodexService,
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
  ) {}

  /** A conversation's project binding cannot be bypassed by a turn cwd. */
  async policyForThread(threadId: string, cwd?: string | null) {
    const binding = this.db
      .select()
      .from(projectAgentThreads)
      .where(eq(projectAgentThreads.threadId, threadId))
      .get();
    const policy = await this.policyForCwd(
      cwd ?? binding?.workspacePath,
      binding?.projectId,
    );
    if (binding && policy?.projectId !== binding.projectId)
      throw new ConflictException(
        'Le dossier de cette conversation ne correspond pas à son projet.',
      );
    return policy;
  }

  /** Returns no override when the cwd is not attached to a WebUI project. */
  async configForCwd(
    cwd: string | null | undefined,
  ): Promise<JsonObject | null> {
    return (await this.policyForCwd(cwd))?.config ?? null;
  }

  /** Resolves every project-owned execution setting from an exact workspace. */
  async policyForCwd(
    cwd: string | null | undefined,
    expectedProjectId?: string,
  ): Promise<ProjectExecutionPolicy | null> {
    if (!cwd) return null;
    let workspace = this.db
      .select({
        id: projectWorkspaces.id,
        projectId: projectWorkspaces.projectId,
        path: projectWorkspaces.path,
      })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.path, cwd))
      .get();
    if (!workspace) {
      const candidate = path.resolve(cwd);
      workspace = this.db
        .select({
          id: projectWorkspaces.id,
          projectId: projectWorkspaces.projectId,
          path: projectWorkspaces.path,
        })
        .from(projectWorkspaces)
        .all()
        .filter((item) => {
          const root = path.resolve(item.path);
          return candidate === root || candidate.startsWith(root + path.sep);
        })
        .sort((a, b) => b.path.length - a.path.length)[0];
    }
    if (!workspace) return null;
    if (expectedProjectId && workspace.projectId !== expectedProjectId)
      throw new ConflictException(
        'Le dossier de cette conversation ne correspond pas à son projet.',
      );
    const copy = workspace.id
      ? this.db
          .select()
          .from(projectWorkspaceCopies)
          .where(eq(projectWorkspaceCopies.localWorkspaceId, workspace.id))
          .get()
      : null;
    const source = copy
      ? this.db
          .select()
          .from(projectWorkspaceResources)
          .where(eq(projectWorkspaceResources.id, copy.sourceResourceId))
          .get()
      : null;
    if (copy && (!source || !source.enabled || copy.state !== 'ready'))
      throw new ConflictException(
        'The source resource for this working copy is no longer available',
      );
    const project = this.db
      .select({
        appIds: projects.appIds,
        mcpServerIds: projects.mcpServerIds,
        agentModel: projects.agentModel,
        agentReasoningEffort: projects.agentReasoningEffort,
      })
      .from(projects)
      .where(eq(projects.id, workspace.projectId))
      .get();
    if (!project) return null;

    // Never treat an empty selection as an empty override: config merges retain
    // global per-app enables and configured MCP servers. Discovery failures are
    // deliberately fatal rather than falling back to unrestricted execution.
    const [apps, mcpServers, effective] = await Promise.all([
      project.appIds.length > 0 ? this.listApps() : Promise.resolve([]),
      this.listMcpServers(),
      this.codex.request<v2.ConfigReadResponse>('config/read', {
        includeLayers: false,
        cwd,
      }),
    ]);
    const object = (value: unknown): JsonObject =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as JsonObject)
        : {};
    const global = effective.config;

    const selectedApps = new Set(project.appIds);
    const appConfig: JsonObject = { _default: { enabled: false } };
    for (const id of Object.keys(object(global.apps)))
      if (id !== '_default') appConfig[id] = { enabled: false };
    for (const app of apps) {
      appConfig[app.id] = {
        enabled: selectedApps.has(app.id) && app.isAccessible && app.isEnabled,
      };
    }

    const selectedMcpServers = new Set(project.mcpServerIds);
    const directMcpConfig: JsonObject = {};
    const pluginConfig: JsonObject = {};
    for (const [name, value] of Object.entries(object(global.mcp_servers))) {
      if (name === 'codex_apps') continue;
      const server = object(value);
      directMcpConfig[name] = {
        ...server,
        enabled: selectedMcpServers.has(name) && server.enabled !== false,
      };
    }
    for (const [id, value] of Object.entries(object(global.plugins))) {
      const plugin = object(value);
      const servers: JsonObject = {};
      for (const [name, raw] of Object.entries(object(plugin.mcp_servers)))
        servers[name] = {
          ...object(raw),
          enabled:
            selectedMcpServers.has(name) && object(raw).enabled !== false,
        };
      pluginConfig[id] = { ...plugin, mcp_servers: servers };
    }
    for (const server of mcpServers) {
      // codex_apps is the built-in connector catalog, not a configured MCP
      // transport. Passing it through mcp_servers makes thread/start reject
      // the complete configuration with "invalid transport".
      if (server.name === 'codex_apps') continue;
      const enabled = selectedMcpServers.has(server.name);
      if (!server.pluginId) {
        // Preserve the full transport configuration returned by config/read.
        if (!directMcpConfig[server.name])
          directMcpConfig[server.name] = { enabled: false };
        continue;
      }
      const plugin = (pluginConfig[server.pluginId] ?? {}) as JsonObject;
      const pluginServers = (plugin.mcp_servers ?? {}) as JsonObject;
      pluginServers[server.name] = {
        ...object(pluginServers[server.name]),
        enabled:
          enabled && object(pluginServers[server.name]).enabled !== false,
      };
      plugin.mcp_servers = pluginServers;
      pluginConfig[server.pluginId] = plugin;
    }

    return {
      executionCwd: cwd,
      projectId: workspace.projectId,
      workspaceId: workspace.id || workspace.path || cwd,
      readOnly: source?.accessMode === 'read_only',
      sourceResourceId: copy?.sourceResourceId ?? null,
      sourceRevision: copy?.revision ?? null,
      model: project.agentModel,
      reasoningEffort: project.agentReasoningEffort,
      config: {
        ...(project.appIds.length === 0 ? { features: { apps: false } } : {}),
        apps: appConfig,
        mcp_servers: directMcpConfig,
        plugins: pluginConfig,
      },
    };
  }

  /** Records the exact local and source context used for an operation. */
  recordExecutionContext(
    policy: ProjectExecutionPolicy,
    cwd: string,
    threadId: string,
  ): void {
    const identity = currentAccess()?.identity;
    this.db
      .insert(projectActivity)
      .values({
        id: randomUUID(),
        projectId: policy.projectId,
        action: 'workspace_context_used',
        entityType: 'agent',
        entityId: threadId,
        label: cwd,
        details: {
          workspaceId: policy.workspaceId,
          sourceResourceId: policy.sourceResourceId,
          sourceRevision: policy.sourceRevision,
          readOnly: policy.readOnly,
        },
        actorPersonId: identity?.personId ?? null,
        actorName: identity?.name ?? 'Système',
        createdAt: Date.now(),
      })
      .run();
  }

  private async listApps(): Promise<v2.AppInfo[]> {
    const result: v2.AppInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.codex.request<v2.AppsListResponse>('app/list', {
        limit: 100,
        cursor,
      });
      result.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return result;
  }

  private async listMcpServers(): Promise<v2.McpServerStatus[]> {
    const result: v2.McpServerStatus[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.codex.request<v2.ListMcpServerStatusResponse>(
        'mcpServerStatus/list',
        { limit: 100, cursor, detail: 'toolsAndAuthOnly' },
      );
      result.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return result;
  }
}
