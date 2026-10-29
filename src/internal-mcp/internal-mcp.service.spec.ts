import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import type { ModuleRef } from '@nestjs/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  people,
  projects,
  projectAgentThreads,
  projectResources,
  projectTaskStatuses,
  projectTasks,
  projectWorkspaces,
  projectParticipants,
  projectPersonGroups,
  projectActivity,
} from '../database/schema';
import { IdentityService } from '../auth/identity.service';
import { accessContext } from '../auth/access-context';
import { FilesService } from '../files/files.service';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { ProjectsService } from '../projects/projects.service';
import { ProjectAgentToolsService } from '../project-knowledge/project-agent-tools.service';
import { SECURITY_SETTING_KEYS } from '../settings/settings.definitions';
import type { SettingsService } from '../settings/settings.service';
import type { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification } from '../codex/codex-schema';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import { InternalMcpService } from './internal-mcp.service';
import { InternalMcpController } from './internal-mcp.controller';
import { internalMcpCatalog, INTERNAL_MCP_TOOLS } from './internal-mcp-catalog';
import { catalogFixture } from '../codex/catalog/catalog.testing';
import { CodexProcessManager as NativeCodexProcessManager } from '../codex/codex-process-manager.service';
import type { v2 } from '../codex/codex-schema';
import { LocalBrowserService } from '../browser/local-browser.service';
import { ConfigService } from '@nestjs/config';
import { ProjectConnectionToolsService } from '../projects/project-connection-tools.service';
import { ProjectLocationsService } from '../projects/project-locations.service';
import { WorkspaceResourcesService } from '../projects/workspace-resources.service';
import type { WorkspaceCopiesService } from '../projects/workspace-copies.service';
import type { WorkspaceGitService } from '../projects/workspace-git.service';
import type { WorkspaceGitActionsService } from '../projects/workspace-git-actions.service';

describe('native internal MCP over HTTP', () => {
  let database: TestDatabase;
  let root: string;
  let service: InternalMcpService;
  let identities: IdentityService;
  let deliverables: DeliverablesService;
  let tools: ProjectAgentToolsService;
  let localBrowser: LocalBrowserService;
  let gitConnectionId: string;
  const gitHead = 'a'.repeat(40),
    gitFingerprint = 'b'.repeat(64);
  const pushConnection = vi.fn();
  let notify: (note: ServerNotification) => void;
  const clients: Client[] = [];
  const setThreadName = vi
    .fn<(id: string, name: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const asPerson = <T>(id: string, operation: () => T) =>
    accessContext.run(
      { identities, identity: identities.resolvePerson(id) },
      operation,
    );

  beforeEach(async () => {
    setThreadName.mockClear();
    pushConnection.mockReset();
    database = createTestDatabase();
    root = await fs.realpath(
      await fs.mkdtemp(path.join(tmpdir(), 'internal-mcp-')),
    );
    const now = Date.now();
    database.db
      .insert(people)
      .values([
        {
          id: 'admin',
          reference: 'admin',
          name: 'Admin',
          role: 'administrator',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'reader',
          reference: 'reader',
          name: 'Reader',
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    database.db
      .insert(projects)
      .values([
        {
          id: 'p',
          name: 'Tests 2',
          workspacePath: root,
          workspaceLayoutVersion: 3,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'other',
          name: 'Other',
          workspacePath: root + '-other',
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    database.db
      .insert(projectWorkspaces)
      .values({
        id: 'w',
        projectId: 'p',
        name: 'Primary',
        path: root,
        primary: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectParticipants)
      .values({ projectId: 'p', personId: 'reader', createdAt: now })
      .run();
    database.db
      .insert(projectPersonGroups)
      .values({
        id: 'secret',
        projectId: 'p',
        name: 'Secret',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectAgentThreads)
      .values(
        ['agent', 'existing-agent'].map((threadId) => ({
          threadId,
          projectId: 'p',
          workspacePath: root,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();
    database.db
      .insert(projectResources)
      .values([
        {
          id: 'tasks',
          projectId: 'p',
          type: 'task_board',
          name: 'Tasks',
          config: {},
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'deliverables',
          projectId: 'p',
          type: 'deliverable_board',
          name: 'Deliverables',
          config: {},
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    database.db
      .insert(projectTaskStatuses)
      .values({
        id: 'todo',
        resourceId: 'tasks',
        name: 'To do',
        kind: 'unassigned',
        position: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const files = new FilesService(
      {
        getStringSetting: (key: string) =>
          key === SECURITY_SETTING_KEYS.workspaceRoots ? root : '',
        getSetting: () => ({ value: '' }),
        onChange: () => () => {},
      } as unknown as SettingsService,
      database.db,
    );
    identities = new IdentityService(database.db);
    deliverables = new DeliverablesService(
      database.db,
      files,
      identities,
      new ActiveFoldersService(database.db),
    );
    const domain = new ProjectsService(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      database.db,
    );
    const resources = new WorkspaceResourcesService(
      database.db,
      new ConfigService({ WEBUI_CONNECTION_SECRET_KEY: 'unit-key' }),
    );
    gitConnectionId = asPerson('admin', () =>
      resources.create('p', {
        type: 'git',
        name: 'Git project',
        address: 'https://github.com/example/private.git',
        accessMode: 'read_write',
        secret: { token: 'never-return-this-token' },
      }),
    ).id;
    const connections = new ProjectConnectionToolsService(
      database.db,
      new ProjectLocationsService(database.db),
      {
        list: () => [
          {
            id: 'own',
            sourceResourceId: gitConnectionId,
            ownerThreadIds: ['agent'],
            branch: 'feature/test',
            revision: gitHead,
            state: 'ready',
            localPath: root,
            accessMode: 'read_write',
          },
        ],
      } as unknown as WorkspaceCopiesService,
      {
        snapshot: () =>
          Promise.resolve({
            head: gitHead,
            branch: 'feature/test',
            fingerprint: gitFingerprint,
          }),
        remoteBranches: () =>
          Promise.resolve({ items: [{ name: 'main', revision: gitHead }] }),
      } as unknown as WorkspaceGitService,
      {
        push: pushConnection,
        stageReview: () =>
          Promise.resolve({
            reviewFingerprint: 'c'.repeat(64),
            files: [{ path: 'README.md', text: 'Untrusted selected content' }],
          }),
      } as unknown as WorkspaceGitActionsService,
    );
    pushConnection.mockImplementation(
      (
        _p: string,
        _c: string,
        _body: unknown,
        publisher: { assertActive: () => void },
      ) => {
        publisher.assertActive();
        return Promise.resolve({ sha: gitHead, branch: 'feature/test' });
      },
    );
    tools = new ProjectAgentToolsService(database.db, deliverables, {
      get: (token: string) =>
        token === 'INTERNAL_MCP_THREAD_RENAMER'
          ? { setThreadName }
          : token === 'PROJECT_CONNECTION_AGENT_TOOLS'
            ? connections
            : domain,
    } as unknown as ModuleRef);
    localBrowser = new LocalBrowserService();
    service = new InternalMcpService(
      tools,
      {
        addListener: (
          _event: string,
          listener: (note: ServerNotification) => void,
        ) => {
          notify = listener;
        },
        addLifecycleListener: vi.fn(),
      } as unknown as CodexProcessManager,
      new CatalogAdmissionService(),
      localBrowser,
    );
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await service.onModuleDestroy();
    database.sqlite.close();
    await fs.rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  async function connect(threadId = 'agent') {
    const connection = await service.connection('p', threadId);
    const client = new Client({
      name: 'mergeron-native-test',
      version: '1.0.0',
    });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.config.url), {
        requestInit: { headers: connection.config.http_headers },
      }),
    );
    return { client, connection };
  }
  function activate(person = 'admin', writes = true, threadId = 'agent') {
    return asPerson(person, () => {
      const lease = service.prepare(threadId, 'p', writes);
      lease?.bind('turn-1');
      return lease;
    });
  }
  const createTask = {
    requestId: 'task-request-1',
    resourceId: 'tasks',
    title: 'Presentation',
    userRequest: 'User requested this task.',
  };

  it('discovers and uses only configured project connections through native MCP, with active-turn write enforcement', async () => {
    const { client } = await connect();
    activate('admin', false);
    const listed = await client.callTool({
      name: 'list_project_connections',
      arguments: {},
    });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      total: 1,
      items: [
        { id: gitConnectionId, protocol: 'git', copies: [{ id: 'own' }] },
      ],
    });
    expect(JSON.stringify(listed)).not.toMatch(
      /never-return-this-token|encryptedValue|authTag/,
    );
    const branches = await client.callTool({
      name: 'read_project_git',
      arguments: { connectionId: gitConnectionId, operation: 'branches' },
    });
    expect(branches.isError).not.toBe(true);
    expect(branches.structuredContent).toMatchObject({
      data: { items: [{ name: 'main' }] },
    });
    const args = {
      connectionId: gitConnectionId,
      copyId: 'own',
      operation: 'push',
      requestId: 'push-1',
      userRequest: 'Please publish this branch.',
      expectedHead: gitHead,
      expectedBranch: 'feature/test',
      fingerprint: gitFingerprint,
    };
    const blocked = await client.callTool({
      name: 'publish_project_git',
      arguments: args,
    });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked)).toContain('READ_ONLY');
    expect(pushConnection).not.toHaveBeenCalled();
    activate();
    const pushed = await client.callTool({
      name: 'publish_project_git',
      arguments: args,
    });
    expect(pushed.isError).not.toBe(true);
    expect(pushed.structuredContent).toMatchObject({
      operation: 'push',
      data: { sha: gitHead },
    });
    await client.callTool({ name: 'publish_project_git', arguments: args });
    expect(pushConnection).toHaveBeenCalledTimes(1);
    service.revoke('agent');
    expect(
      (
        await client.callTool({
          name: 'list_project_connections',
          arguments: {},
        })
      ).isError,
    ).toBe(true);
  });

  it('exposes controlled preparation as a real MCP object schema and validates operation fields server-side', async () => {
    const { client } = await connect();
    const args = {
      connectionId: gitConnectionId,
      copyId: 'own',
      operation: 'stage_review',
      paths: ['README.md'],
      requestId: 'review-1',
      userRequest: 'Please commit the selected documentation changes.',
      expectedHead: gitHead,
      expectedBranch: 'feature/test',
      fingerprint: gitFingerprint,
    };
    activate('admin', false);
    expect(
      (await client.callTool({ name: 'prepare_project_git', arguments: args }))
        .isError,
    ).toBe(true);
    activate();
    const result = await client.callTool({
      name: 'prepare_project_git',
      arguments: args,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      operation: 'stage_review',
      untrustedContent: true,
      data: { reviewFingerprint: 'c'.repeat(64) },
    });
    // Flat schemas are needed by the SDK, but do not weaken per-operation checks.
    expect(
      (
        await client.callTool({
          name: 'prepare_project_git',
          arguments: { ...args, operation: 'commit', message: 'x' },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: 'prepare_project_git',
          arguments: { ...args, authorName: 'spoof' },
        })
      ).isError,
    ).toBe(true);
    service.revoke('agent');
    expect(
      (await client.callTool({ name: 'prepare_project_git', arguments: args }))
        .isError,
    ).toBe(true);
  });

  it('binds local browser commands to the administrator, agent and active writable turn', async () => {
    const { client } = await connect();
    activate();
    const sessionId = localBrowser.open('admin', 'agent').id;
    const shared = {
      state: 'shared',
      epoch: 'page',
      url: 'https://example.org/',
    };
    localBrowser.poll('admin', 'agent', sessionId, shared);
    const read = await client.callTool({
      name: 'local_browser_read',
      arguments: { operation: 'observe', sessionId },
    });
    expect(read.isError).not.toBe(true);
    const observation = localBrowser.poll('admin', 'agent', sessionId, shared)
      .dispatch[0];
    localBrowser.poll('admin', 'agent', sessionId, {
      ...shared,
      results: [
        {
          id: observation.id,
          executionId: observation.executionId,
          result: {
            snapshotId: 'snapshot',
            elements: [{ id: 'element', tag: 'button', text: 'Save' }],
          },
        },
      ],
    });
    expect(
      (
        await client.callTool({
          name: 'local_browser_read',
          arguments: { operation: 'status' },
        })
      ).structuredContent,
    ).toMatchObject({ sessions: [{ id: sessionId }] });
    const pending = await client.callTool({
      name: 'local_browser_action',
      arguments: {
        sessionId,
        action: 'click',
        snapshotId: 'snapshot',
        elementId: 'element',
      },
    });
    expect(pending.structuredContent).toMatchObject({ status: 'approval' });
    service.revoke('agent');
    expect(() =>
      localBrowser.decide(
        'admin',
        'agent',
        sessionId,
        String(pending.structuredContent?.commandId),
        true,
      ),
    ).toThrow('NO_ACTIVE_TURN');
    activate('admin', false);
    expect(
      (
        await client.callTool({
          name: 'local_browser_action',
          arguments: {
            sessionId,
            action: 'scroll',
            snapshotId: 'snapshot',
            y: 10,
          },
        })
      ).isError,
    ).toBe(true);
    activate('reader', true);
    expect(
      (
        await client.callTool({
          name: 'local_browser_read',
          arguments: { operation: 'status' },
        })
      ).isError,
    ).toBe(true);
    activate();
    const other = localBrowser.open('admin', 'other-agent').id;
    expect(
      (
        await client.callTool({
          name: 'local_browser_read',
          arguments: { operation: 'observe', sessionId: other },
        })
      ).isError,
    ).toBe(true);
  });

  it('renames only its own agent even in filesystem read-only mode, with audit and idempotency', async () => {
    const { client } = await connect();
    activate('admin', false);
    const args = {
      requestId: 'rename-1',
      title: 'Qualité PLM',
      userRequest: 'Please rename this agent.',
    };
    const result = await client.callTool({
      name: 'rename_agent',
      arguments: args,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      threadId: 'agent',
      name: 'Qualité PLM',
      status: 'renamed',
    });
    await client.callTool({ name: 'rename_agent', arguments: args });
    expect(setThreadName).toHaveBeenCalledExactlyOnceWith(
      'agent',
      'Qualité PLM',
    );
    const audit = database.db.select().from(projectActivity).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'agent_renamed',
      entityId: 'agent',
    });
    const forged = await client.callTool({
      name: 'rename_agent',
      arguments: { ...args, threadId: 'other' },
    });
    expect(forged.isError).toBe(true);
    const conflict = await client.callTool({
      name: 'rename_agent',
      arguments: { ...args, title: 'Different' },
    });
    expect(conflict.isError).toBe(true);
    expect(setThreadName).toHaveBeenCalledTimes(1);
  });

  it('never renames without an active authorized turn or after revocation', async () => {
    const { client } = await connect();
    const args = {
      requestId: 'rename-2',
      title: 'Name',
      userRequest: 'Rename please.',
    };
    expect(
      (await client.callTool({ name: 'rename_agent', arguments: args }))
        .isError,
    ).toBe(true);
    activate();
    service.revoke('agent');
    expect(
      (await client.callTool({ name: 'rename_agent', arguments: args }))
        .isError,
    ).toBe(true);
    expect(setThreadName).not.toHaveBeenCalled();
  });

  it('negotiates MCP and exposes exactly the schemas displayed by administration', async () => {
    const { client } = await connect();
    expect(client.getServerVersion()?.name).toBe('mergeron_internal');
    const { tools: advertised } = await client.listTools();
    const catalog = internalMcpCatalog();
    expect(advertised).toHaveLength(INTERNAL_MCP_TOOLS.length);
    for (const method of catalog.tools) {
      const native = advertised.find((tool) => tool.name === method.name)!;
      expect(native.inputSchema).toEqual(method.inputSchema);
      expect(native.outputSchema).toEqual(method.outputSchema);
      expect(native.annotations?.readOnlyHint).toBe(method.readOnly);
    }
    expect(JSON.stringify(catalog)).not.toContain('Bearer ');
  });

  it('executes all seven native tools, creates real entities and preserves idempotency', async () => {
    const { client } = await connect();
    activate();
    const project = await client.callTool({
      name: 'get_project',
      arguments: {},
    });
    expect(project.structuredContent).toMatchObject({
      project: { name: 'Tests 2' },
    });
    const task = await client.callTool({
      name: 'create_task',
      arguments: createTask,
    });
    expect(task.isError).not.toBe(true);
    expect(task.structuredContent).toMatchObject({
      status: 'created',
      title: 'Presentation',
    });
    expect(
      await client.callTool({ name: 'create_task', arguments: createTask }),
    ).toEqual(task);
    expect(database.db.select().from(projectTasks).all()).toHaveLength(1);
    const taskId = (task.structuredContent as { id: string }).id;
    expect(
      (
        await client.callTool({
          name: 'list_tasks',
          arguments: { query: 'Presentation' },
        })
      ).structuredContent,
    ).toMatchObject({ total: 1 });
    expect(
      (await client.callTool({ name: 'get_task', arguments: { id: taskId } }))
        .structuredContent,
    ).toMatchObject({ title: 'Presentation', parentTaskId: null });
    const item = await client.callTool({
      name: 'create_deliverable',
      arguments: {
        ...createTask,
        requestId: 'deliverable-request-1',
        resourceId: 'deliverables',
      },
    });
    expect(item.isError).not.toBe(true);
    const itemId = (item.structuredContent as { id: string }).id;
    expect(
      (await client.callTool({ name: 'list_deliverables', arguments: {} }))
        .structuredContent,
    ).toMatchObject({ total: 1 });
    expect(
      (
        await client.callTool({
          name: 'get_deliverable',
          arguments: { id: itemId },
        })
      ).structuredContent,
    ).toMatchObject({ title: 'Presentation', linkedToThisConversation: false });
    expect(
      database.db
        .select()
        .from(projectActivity)
        .all()
        .filter((item) => item.action === 'agent_created'),
    ).toHaveLength(2);
  });

  it('supports existing conversations, read-only reads and server-side creation refusal', async () => {
    const { client } = await connect('existing-agent');
    activate('admin', false, 'existing-agent');
    expect(
      (await client.callTool({ name: 'get_project', arguments: {} })).isError,
    ).not.toBe(true);
    expect(
      (await client.callTool({ name: 'create_task', arguments: createTask }))
        .isError,
    ).toBe(true);
    expect(database.db.select().from(projectTasks).all()).toHaveLength(0);
  });

  it('refuses project/path spoofing, invalid parameters and unsupported tools', async () => {
    const { client } = await connect();
    activate();
    for (const args of [
      { ...createTask, projectId: 'other' },
      { ...createTask, path: '/etc/passwd' },
      { ...createTask, title: '' },
      { ...createTask, title: 'x'.repeat(201) },
    ]) {
      expect(
        (await client.callTool({ name: 'create_task', arguments: args }))
          .isError,
      ).toBe(true);
    }
    expect(
      (await client.callTool({ name: 'missing_tool', arguments: {} })).isError,
    ).toBe(true);
    expect(database.db.select().from(projectTasks).all()).toHaveLength(0);
  });

  it('filters confidential deliverables and rechecks revoked roles and memberships', async () => {
    await asPerson('admin', () =>
      deliverables.create('p', 'deliverables', {
        title: 'Secret roadmap',
        confidentiality: 'restricted',
        authorizedGroupIds: ['secret'],
      }),
    );
    const { client } = await connect();
    activate('reader');
    expect(
      (await client.callTool({ name: 'list_deliverables', arguments: {} }))
        .structuredContent,
    ).toMatchObject({ total: 0 });
    expect(
      (await client.callTool({ name: 'create_task', arguments: createTask }))
        .isError,
    ).toBe(true);
    database.db.delete(projectParticipants).run();
    expect(
      (await client.callTool({ name: 'get_project', arguments: {} })).isError,
    ).toBe(true);
    activate();
    database.db
      .update(people)
      .set({ role: 'standard' })
      .where(eq(people.id, 'admin'))
      .run();
    expect(
      (await client.callTool({ name: 'create_task', arguments: createTask }))
        .isError,
    ).toBe(true);
  });

  it('requires a running authenticated turn and revokes on stop, completion and rebind', async () => {
    const { client } = await connect();
    expect(
      (await client.callTool({ name: 'get_project', arguments: {} })).isError,
    ).toBe(true);
    const lease = asPerson('admin', () => service.prepare('agent', 'p', true));
    expect(
      (await client.callTool({ name: 'get_project', arguments: {} })).isError,
    ).toBe(true);
    lease?.bind('turn-1');
    notify({
      method: 'turn/completed',
      params: {
        threadId: 'agent',
        turn: { id: 'turn-1', status: 'completed' },
      },
    } as unknown as ServerNotification);
    expect(
      (await client.callTool({ name: 'get_project', arguments: {} })).isError,
    ).toBe(true);
    activate();
    service.revoke('agent');
    expect(
      (await client.callTool({ name: 'get_project', arguments: {} })).isError,
    ).toBe(true);
    activate();
    database.db
      .update(projectAgentThreads)
      .set({ projectId: 'other' })
      .where(eq(projectAgentThreads.threadId, 'agent'))
      .run();
    expect(
      (await client.callTool({ name: 'create_task', arguments: createTask }))
        .isError,
    ).toBe(true);
  });

  it('authenticates every HTTP call, rejects browser origins and bounds requests', async () => {
    const { connection } = await connect();
    expect(
      (await fetch(connection.config.url, { method: 'POST', body: '{}' }))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(connection.config.url, {
          method: 'POST',
          headers: {
            ...connection.config.http_headers,
            Origin: 'https://evil.example',
          },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(connection.config.url, {
          method: 'POST',
          headers: connection.config.http_headers,
          body: 'x'.repeat(33000),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await fetch(connection.config.url, {
          method: 'POST',
          headers: connection.config.http_headers,
          body: 'bad json',
        })
      ).status,
    ).toBe(400);
  });

  it('keeps connection identity stable while rotating authenticated execution leases', async () => {
    const first = await service.connection('p', 'agent');
    expect(await service.connection('p', 'agent')).toEqual(first);
    const old = activate();
    const replacement = activate();
    expect(old).not.toBe(replacement);
    const pending = await service.connection('p');
    service.bind(pending.id, 'new-agent', 'p');
    expect(await service.connection('p', 'new-agent')).toEqual(pending);
  });

  it('protects the technical catalog with administrator authorization', () => {
    const controller = new InternalMcpController();
    expect(() => controller.catalog()).toThrow();
    expect(() => asPerson('reader', () => controller.catalog())).toThrow();
    expect(asPerson('admin', () => controller.catalog()).tools).toHaveLength(
      INTERNAL_MCP_TOOLS.length,
    );
  });

  it('is discovered as native tools by the pinned Codex app-server without inference', async () => {
    const fixture = catalogFixture();
    const manager = new NativeCodexProcessManager(fixture.storage, {
      getStringSetting: () => null,
    } as unknown as SettingsService);
    try {
      await manager.onModuleInit();
      const rpc = manager.getClient();
      expect(rpc).not.toBeNull();
      const connection = await service.connection('p');
      const started = await rpc!.request<v2.ThreadStartResponse>(
        'thread/start',
        {
          cwd: fixture.home,
          ephemeral: true,
          config: {
            features: { apps: false },
            mcp_servers: { mergeron_internal: connection.config },
          },
        },
      );
      service.bind(connection.id, started.thread.id, 'p');
      const deadline = Date.now() + 15000;
      let inventory: v2.ListMcpServerStatusResponse;
      do {
        inventory = await rpc!.request<v2.ListMcpServerStatusResponse>(
          'mcpServerStatus/list',
          { threadId: started.thread.id, detail: 'toolsAndAuthOnly' },
        );
        if (
          inventory.data.some(
            (server) =>
              server.name === 'mergeron_internal' &&
              Object.keys(server.tools).length === INTERNAL_MCP_TOOLS.length,
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      const internal = inventory!.data.find(
        (server) => server.name === 'mergeron_internal',
      );
      expect(Object.keys(internal?.tools ?? {})).toHaveLength(
        INTERNAL_MCP_TOOLS.length,
      );
      expect(Object.keys(internal?.tools ?? {})).toContain(
        'create_deliverable',
      );
    } finally {
      const rpc = manager.getClient();
      const closed = rpc
        ? new Promise<void>((resolve) => rpc.once('close', () => resolve()))
        : Promise.resolve();
      manager.onModuleDestroy();
      await closed;
      fixture.cleanup();
    }
  }, 25000);
});
