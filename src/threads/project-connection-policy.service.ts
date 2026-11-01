/** Builds per-project Codex app and MCP enablement overrides for new threads. */
import {
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { InternalMcpService } from '../internal-mcp/internal-mcp.service';
import { INTERNAL_MCP_NAME } from '../internal-mcp/internal-mcp-catalog';
import { agentCopyPermissions } from '../projects/agent-copy-permissions';
import { randomUUID } from 'node:crypto';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
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
} from '../database/schema';

type JsonObject = { [key: string]: JsonValue };

/** Effective config serializes absent optionals as null; TOML overrides must omit them. */
function transportOverrides(value: {
  [key: string]: JsonValue | undefined;
}): JsonObject {
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) continue;
    result[key] = Array.isArray(entry)
      ? entry.map((item) =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? transportOverrides(item)
            : item,
        )
      : typeof entry === 'object'
        ? transportOverrides(entry)
        : entry;
  }
  return result;
}

export interface ProjectExecutionPolicy {
  internalMcpId?: string;
  copyPermissions?: {
    writable: string;
    readOnly: string;
    baseProfile: string;
    writableCopyPath: string | null;
    readOnlyRoots: string[];
  };
  executionCwd?: string;
  projectId: string;
  config: JsonObject;
  model: string | null;
  reasoningEffort: string | null;
  workspaceId: string;
  locationId?: string;
  readOnly: boolean;
  sourceResourceId: string | null;
  sourceRevision: string | null;
}

@Injectable()
export class ProjectConnectionPolicyService {
  constructor(
    private readonly codex: CodexService,
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly folders: ActiveFoldersService,
    @Optional() private readonly internalMcp?: InternalMcpService,
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
      threadId,
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
    threadId?: string,
  ): Promise<ProjectExecutionPolicy | null> {
    const location = this.folders.executionLocationForCwd(
      cwd,
      expectedProjectId,
    );
    if (!location) return null;
    const project = this.db
      .select({
        appIds: projects.appIds,
        mcpServerIds: projects.mcpServerIds,
        agentModel: projects.agentModel,
        agentReasoningEffort: projects.agentReasoningEffort,
      })
      .from(projects)
      .where(eq(projects.id, location.projectId))
      .get();
    if (!project)
      throw new ConflictException(
        'The execution project is no longer available',
      );

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
    this.assertExecutionLocation(location, cwd);
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
      const server = transportOverrides(object(value));
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
          ...transportOverrides(object(raw)),
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

    const baseProfile =
      typeof global.default_permissions === 'string'
        ? global.default_permissions
        : global.sandbox_mode === 'read-only' || location.readOnly
          ? ':read-only'
          : ':workspace';
    if (![':workspace', ':read-only'].includes(baseProfile))
      throw new ConflictException('GIT_COPY_ISOLATION_UNAVAILABLE');
    const copyPermissions = agentCopyPermissions(
      this.db,
      location.projectId,
      threadId,
      baseProfile,
      threadId ? undefined : cwd,
    );
    const internal = await this.internalMcp?.connection(
      location.projectId,
      threadId,
    );
    if (internal) directMcpConfig[INTERNAL_MCP_NAME] = internal.config;
    return {
      ...(internal ? { internalMcpId: internal.id } : {}),
      executionCwd: cwd ?? undefined,
      copyPermissions: {
        writable: copyPermissions.writable,
        readOnly: copyPermissions.readOnly,
        baseProfile,
        writableCopyPath: copyPermissions.writableCopyPath,
        readOnlyRoots: copyPermissions.readOnlyRoots,
      },
      ...location,
      model: project.agentModel,
      reasoningEffort: project.agentReasoningEffort,
      config: {
        ...(project.appIds.length === 0 ? { features: { apps: false } } : {}),
        default_permissions: location.readOnly
          ? copyPermissions.readOnly
          : copyPermissions.writable,
        permissions: {
          ...object(global.permissions),
          ...copyPermissions.config,
        } as JsonObject,
        apps: appConfig,
        mcp_servers: directMcpConfig,
        plugins: pluginConfig,
      },
    };
  }

  assertCopyOwnership(
    policy: ProjectExecutionPolicy | null,
    threadId: string,
  ): void {
    if (!policy?.copyPermissions) return;
    const current = agentCopyPermissions(
      this.db,
      policy.projectId,
      threadId,
      policy.copyPermissions.baseProfile,
    );
    if (current.writable !== policy.copyPermissions.writable)
      throw new ConflictException('GIT_COPY_OWNED');
  }

  /** Recheck after asynchronous preparation, immediately before native dispatch. */
  assertExecutionLocation(
    policy: Pick<
      ProjectExecutionPolicy,
      | 'projectId'
      | 'workspaceId'
      | 'locationId'
      | 'readOnly'
      | 'sourceResourceId'
      | 'sourceRevision'
    > | null,
    cwd?: string | null,
  ): void {
    const latest = this.folders.executionLocationForCwd(cwd, policy?.projectId);
    const keys = [
      'projectId',
      'workspaceId',
      'locationId',
      'readOnly',
      'sourceResourceId',
      'sourceRevision',
    ] as const;
    if (keys.some((key) => (policy?.[key] ?? null) !== (latest?.[key] ?? null)))
      throw new ConflictException(
        'The execution location changed during preparation. Retry with the current project location.',
      );
  }

  /** Records the exact local and source context used for an operation. */
  recordExecutionContext(
    policy: ProjectExecutionPolicy,
    cwd: string,
    threadId: string,
  ): void {
    if (policy.internalMcpId)
      this.internalMcp?.bind(policy.internalMcpId, threadId, policy.projectId);
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
          locationId: policy.locationId ?? null,
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
