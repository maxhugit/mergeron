import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projects,
  projectResources,
  projectWorkspaces,
  projectAgentThreads,
} from '../database/schema';
import { FilesService } from '../files/files.service';
import { IdentityService } from '../auth/identity.service';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { DocumentProtectionService } from './document-protection.service';
import { DocumentPublicationService } from './document-publication.service';
import { SECURITY_SETTING_KEYS } from '../settings/settings.definitions';
import type { SettingsService } from '../settings/settings.service';
import type { DatabaseService } from '../database/database.service';
import { eq } from 'drizzle-orm';
import {
  projectDeliverableDocuments as documents,
  projectDeliverableDocumentVersions as versions,
} from '../database/schema';
import { migrateDeliverableDocumentRoots } from '../deliverables/document-root-migration';
import { accessContext } from '../auth/access-context';
import {
  projectDraftPath,
  projectSystemPath,
} from '../projects/workspace-structure';
import type { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ProjectAgentToolsService } from '../project-knowledge/project-agent-tools.service';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ServerNotification } from '../codex/codex-schema';

// macOS has no /proc. Preserve the same opened-handle path check in local tests;
// the Linux mount/descriptor boundary is additionally exercised on the dev host.
const descriptors = vi.hoisted(() => new Map<number, string>());
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      descriptors.set(file.fd, String(args[0]));
      return file;
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const match = /^\/proc\/self\/fd\/(\d+)$/.exec(String(args[0]));
      return actual.realpath(
        match ? descriptors.get(Number(match[1]))! : args[0],
      );
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const match =
        typeof args[0] === 'string' &&
        /^\/proc\/self\/fd\/(\d+)(\/.*)$/.exec(args[0]);
      if (match) args[0] = descriptors.get(Number(match[1]))! + match[2];
      return actual.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      for (const index of [0, 1] as const) {
        const match = /^\/proc\/self\/fd\/(\d+)(\/.*)$/.exec(
          String(args[index]),
        );
        if (match) args[index] = descriptors.get(Number(match[1]))! + match[2];
      }
      return actual.rename(...args);
    },
  };
});

describe('agent saves retained documents as new versions', () => {
  let database: TestDatabase;
  let root: string;
  let deliverables: DeliverablesService;
  let publication: DocumentPublicationService;
  let files: FilesService;
  let item: Awaited<ReturnType<DeliverablesService['create']>>;
  let notifyTool: (note: ServerNotification) => void;

  beforeEach(async () => {
    vi.stubEnv('MERGERON_PUBLISHED_DOCUMENT_PROTECTION', 'required');
    database = createTestDatabase();
    root = await fs.realpath(
      await fs.mkdtemp(path.join(tmpdir(), 'agent-document-')),
    );
    await fs.mkdir(path.join(root, '.mergeron'));
    const now = Date.now();
    database.db
      .insert(projects)
      .values({
        id: 'p',
        name: 'Project',
        workspacePath: root,
        workspaceLayoutVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
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
      .insert(projectResources)
      .values({
        id: 'r',
        projectId: 'p',
        name: 'Deliverables',
        type: 'deliverable_board',
        config: {},
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'agent',
        projectId: 'p',
        workspacePath: root,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    files = new FilesService(
      {
        getStringSetting: (key: string) =>
          key === SECURITY_SETTING_KEYS.workspaceRoots ? root : '',
        getSetting: () => ({ value: '' }),
        onChange: () => () => {},
      } as unknown as SettingsService,
      database.db,
    );
    deliverables = new DeliverablesService(
      database.db,
      files,
      new IdentityService(database.db),
      new ActiveFoldersService(database.db),
    );
    const protection = new DocumentProtectionService(database.db, {
      databasePath: ':memory:',
    } as DatabaseService);
    publication = new DocumentPublicationService(
      database.db,
      deliverables,
      protection,
      {
        addListener: (
          _event: string,
          listener: (note: ServerNotification) => void,
        ) => {
          notifyTool = listener;
        },
        addLifecycleListener: vi.fn(),
      } as unknown as CodexProcessManager,
    );
    item = await deliverables.create('p', 'r', { title: 'Report' });
  });

  afterEach(async () => {
    await fs.rm(projectDraftPath(root), { recursive: true, force: true });
    await fs.rm(projectSystemPath(root), { recursive: true, force: true });
    publication.onModuleDestroy();
    database.sqlite.close();
    await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    descriptors.clear();
  });

  function projectToolBridge() {
    publication.onModuleDestroy();
    const execute = vi
      .fn()
      .mockResolvedValue({ id: 'task-1', status: 'created' });
    publication = new DocumentPublicationService(
      database.db,
      deliverables,
      new DocumentProtectionService(database.db, {
        databasePath: ':memory:',
      } as DatabaseService),
      {
        addListener: (
          _event: string,
          listener: (note: ServerNotification) => void,
        ) => {
          notifyTool = listener;
        },
        addLifecycleListener: vi.fn(),
      } as unknown as CodexProcessManager,
      { execute } as unknown as ProjectAgentToolsService,
    );
    const identities = new IdentityService(database.db);
    const access = {
      identities,
      identity: {
        kind: 'service' as const,
        personId: null,
        name: 'Service',
        role: 'administrator' as const,
        active: true,
      },
    };
    return {
      execute,
      prepare: async (writable = true) => {
        const prepared = await accessContext.run(access, () =>
          publication.prepare('agent', 'Writer', writable),
        );
        prepared?.bind('tool-turn');
        return prepared;
      },
    };
  }

  function toolNotification(
    value: Record<string, unknown>,
    commandId = randomUUID(),
  ) {
    const scope = publication['scopes'].get('agent')!;
    return {
      method: 'item/completed',
      params: {
        threadId: 'agent',
        turnId: 'tool-turn',
        item: {
          type: 'commandExecution',
          id: commandId,
          command: `python3 "${path.join(scope.directory, 'mergeron-tools.py')}" --request ${Buffer.from(JSON.stringify(value)).toString('base64url')}`,
          exitCode: 0,
          status: 'completed',
        },
      },
    } as unknown as ServerNotification;
  }

  async function toolRequest(
    value: Record<string, unknown>,
    commandId?: string,
  ) {
    const scope = publication['scopes'].get('agent')!;
    notifyTool(toolNotification(value, commandId));
    await publication.scan(scope);
    return JSON.parse(
      await fs.readFile(
        path.join(
          scope.directory,
          `project-tool-${String(value.requestId)}-result.json`,
        ),
        'utf8',
      ),
    ) as {
      requestId: string | null;
      status: string;
      result?: Record<string, unknown>;
    };
  }

  it('dispatches only completed commands from the authenticated conversation and deduplicates wire events', async () => {
    const bridge = projectToolBridge();
    const prepared = await bridge.prepare();
    expect(prepared?.context).toContain('mergeron-tools.py');
    const request = {
      requestId: 'create-1',
      tool: 'create_task',
      resourceId: 'tasks',
      title: 'Presentation',
      userRequest: 'Create a task',
    };
    expect(await toolRequest(request, 'command-1')).toMatchObject({
      requestId: 'create-1',
      status: 'ok',
      result: { id: 'task-1' },
    });
    expect(bridge.execute).toHaveBeenCalledTimes(1);
    expect(await toolRequest(request, 'command-1')).toMatchObject({
      status: 'ok',
    });
    expect(bridge.execute).toHaveBeenCalledTimes(1);
    await toolRequest({ ...request, requestId: 'read-1', tool: 'get_project' });
    await toolRequest(request);
    // A new command with the same request id goes through durable domain idempotency.
    expect(bridge.execute).toHaveBeenCalledTimes(3);
  });

  it('provides an executable Python client that waits for the server acknowledgement', async () => {
    const bridge = projectToolBridge();
    await bridge.prepare();
    const scope = publication['scopes'].get('agent')!;
    const helper = path.join(scope.directory, 'mergeron-tools.py');
    const input = { requestId: 'client-1', tool: 'get_project' };
    const before = await fs.readdir(scope.directory);
    const encoded = await promisify(execFile)('python3', [
      helper,
      '--encode',
      JSON.stringify(input),
    ]);
    const submitted = await promisify(execFile)('python3', [
      helper,
      '--request',
      encoded.stdout.trim(),
    ]);
    expect(JSON.parse(submitted.stdout)).toMatchObject({ status: 'submitted' });
    expect(await fs.readdir(scope.directory)).toEqual(before);
    await toolRequest(input);
    const { stdout } = await promisify(execFile)(
      'python3',
      [helper, '--result', 'client-1'],
      { timeout: 10000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      requestId: 'client-1',
      status: 'ok',
      result: { id: 'task-1' },
    });
    expect(bridge.execute).toHaveBeenCalledOnce();
  }, 15000);

  it('refuses creates in read-only mode without elevating the sandbox', async () => {
    const bridge = projectToolBridge();
    await bridge.prepare(false);
    expect(
      await toolRequest({ requestId: 'create-1', tool: 'create_task' }),
    ).toMatchObject({ status: 'failed' });
    expect(bridge.execute).not.toHaveBeenCalled();
    expect(
      await toolRequest({ requestId: 'read-1', tool: 'get_project' }),
    ).toMatchObject({ status: 'ok' });
  });

  it('supports a project with no deliverables manager without creating one', async () => {
    const bridge = projectToolBridge();
    database.db
      .delete(projectResources)
      .where(eq(projectResources.id, 'r'))
      .run();
    const prepared = await bridge.prepare();
    expect(prepared?.context).toContain('no deliverables manager');
    expect(prepared?.context).toContain('mergeron-tools.py');
    expect(
      await toolRequest({ requestId: 'read-1', tool: 'get_project' }),
    ).toMatchObject({ status: 'ok' });
    expect(database.db.select().from(projectResources).all()).toHaveLength(0);
  });

  it('revokes tools on stop and refuses a changed project binding', async () => {
    const bridge = projectToolBridge();
    await bridge.prepare();
    database.db.delete(projectAgentThreads).run();
    expect(
      await toolRequest({ requestId: 'read-1', tool: 'get_project' }),
    ).toMatchObject({ status: 'failed' });
    expect(bridge.execute).not.toHaveBeenCalled();
    const scope = publication['scopes'].get('agent')!;
    publication.revoke('agent');
    await publication.scan(scope);
    expect(bridge.execute).not.toHaveBeenCalled();
  });

  it('ignores forged file requests and expires security-mode leases', async () => {
    const bridge = projectToolBridge();
    await bridge.prepare();
    const scope = publication['scopes'].get('agent')!;
    const outside = path.join(root, 'outside-tool.json');
    await fs.writeFile(
      outside,
      JSON.stringify({ requestId: 'read-1', tool: 'get_project' }),
    );
    await fs.symlink(
      outside,
      path.join(scope.directory, 'project-tool-request.json'),
    );
    await publication.scan(scope);
    expect(bridge.execute).not.toHaveBeenCalled();
    await bridge.prepare(false);
    expect(publication['scopes'].get('agent')?.directory).not.toBe(
      scope.directory,
    );
    expect(scope.revoked).toBe(true);
  });

  it('does not admit failed, declined, unfinished, wrong-turn or wrong-conversation commands', async () => {
    const bridge = projectToolBridge();
    await bridge.prepare();
    const scope = publication['scopes'].get('agent')!;
    for (const status of ['failed', 'declined', 'inProgress'] as const) {
      const note = toolNotification({
        requestId: 'read-1',
        tool: 'get_project',
      });
      if (
        note.method !== 'item/completed' ||
        note.params.item.type !== 'commandExecution'
      )
        throw new Error('Unexpected fixture');
      note.params.item.status = status;
      notifyTool(note);
    }
    const failed = toolNotification({
      requestId: 'read-1',
      tool: 'get_project',
    });
    if (
      failed.method !== 'item/completed' ||
      failed.params.item.type !== 'commandExecution'
    )
      throw new Error('Unexpected fixture');
    failed.params.item.exitCode = 1;
    notifyTool(failed);
    const oldTurn = toolNotification({
      requestId: 'read-1',
      tool: 'get_project',
    });
    if (oldTurn.method !== 'item/completed')
      throw new Error('Unexpected fixture');
    oldTurn.params.turnId = 'old-turn';
    notifyTool(oldTurn);
    const other = toolNotification({
      requestId: 'read-1',
      tool: 'get_project',
    });
    if (other.method !== 'item/completed')
      throw new Error('Unexpected fixture');
    other.params.threadId = 'another-agent';
    notifyTool(other);
    await publication.scan(scope);
    expect(bridge.execute).not.toHaveBeenCalled();
    expect(scope.toolQueue).toHaveLength(0);
  });

  it('rejects a helper invocation from another active conversation even when the path is known', async () => {
    const bridge = projectToolBridge();
    await bridge.prepare();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'another-agent',
        projectId: 'p',
        workspacePath: root,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const identities = new IdentityService(database.db);
    const second = await accessContext.run(
      {
        identities,
        identity: {
          kind: 'service',
          personId: null,
          name: 'Service',
          role: 'administrator',
          active: true,
        },
      },
      () => publication.prepare('another-agent', 'Other', true),
    );
    second?.bind('tool-turn');
    const note = toolNotification({
      requestId: 'cross-agent',
      tool: 'get_project',
    });
    if (note.method !== 'item/completed') throw new Error('Unexpected fixture');
    note.params.threadId = 'another-agent';
    notifyTool(note);
    await publication.scan(publication['scopes'].get('agent')!);
    await publication.scan(publication['scopes'].get('another-agent')!);
    expect(bridge.execute).not.toHaveBeenCalled();
  });

  async function request(
    input: Record<string, unknown>,
    content = 'Version one',
  ) {
    await publication.prepare('agent', 'Writer');
    const scope = publication['scopes'].get('agent')!;
    await fs.writeFile(path.join(scope.directory, 'report.docx'), content);
    expect(
      (await publication['readDraft'](scope, 'report.docx', 1024)).toString(),
    ).toBe(content);
    await fs.writeFile(
      path.join(scope.directory, 'publication-request.json'),
      JSON.stringify({
        requestId: 'save-1',
        resourceId: 'r',
        deliverableId: item.id,
        file: 'report.docx',
        comment: 'Written by agent',
        ...input,
      }),
    );
    await publication.scan(scope);
    return {
      scope,
      result: JSON.parse(
        await fs.readFile(
          path.join(scope.directory, 'publication-result.json'),
          'utf8',
        ),
      ) as Record<string, unknown>,
    };
  }

  it('retains a protected source, immutable V1, actor and version comment', async () => {
    const { result } = await request({});
    expect(result.status).toBe('published');
    const document = deliverables.board('p', 'r').deliverables[0].documents[0];
    expect(document.sourcePath).toBe(
      path.join(root, 'livrables', item.id, 'report.docx'),
    );
    expect(document.versions[0]).toMatchObject({
      number: 1,
      authorName: 'Agent — Writer',
      comment: 'Written by agent',
    });
    expect(await fs.readFile(document.sourcePath, 'utf8')).toBe('Version one');
    expect(await fs.readFile(document.versions[0].snapshotPath, 'utf8')).toBe(
      'Version one',
    );
  });

  it('keeps versions in the separate system space while the current file remains in the working space', async () => {
    const system = projectSystemPath(root);
    await fs.mkdir(path.dirname(system), { recursive: true });
    await fs.rename(path.join(root, '.mergeron'), system);
    database.db.update(projects).set({ workspaceLayoutVersion: 3 }).run();
    expect((await request({})).result.status).toBe('published');
    const document = deliverables.board('p', 'r').deliverables[0].documents[0];
    expect(document.sourcePath).toBe(
      path.join(root, 'livrables', item.id, 'report.docx'),
    );
    expect(document.versions[0].snapshotPath).toContain(
      path.join(system, 'history'),
    );
    expect(await fs.readFile(document.versions[0].snapshotPath, 'utf8')).toBe(
      'Version one',
    );
    expect(
      deliverables.onlyOfficeHistory(document.sourcePath)?.versions,
    ).toHaveLength(1);
    expect((await publication.prepare('agent'))?.draftDirectory).toContain(
      projectDraftPath(root),
    );
  });

  it('creates V2 and refuses stale writes without overwriting either version', async () => {
    await request({});
    const original = deliverables.board('p', 'r').deliverables[0].documents[0];
    const second = await request(
      { requestId: 'save-2', documentId: original.id, expectedVersion: 1 },
      'Version two',
    );
    expect(second.result.status).toBe('published');
    const stale = await request(
      { requestId: 'save-3', documentId: original.id, expectedVersion: 1 },
      'Stale',
    );
    expect(stale.result.status).toBe('failed');
    const document = deliverables.board('p', 'r').deliverables[0].documents[0];
    expect(document.currentVersionNumber).toBe(2);
    expect(await fs.readFile(document.sourcePath, 'utf8')).toBe('Version two');
    expect(
      await fs.readFile(
        document.versions.find((version) => version.number === 1)!.snapshotPath,
        'utf8',
      ),
    ).toBe('Version one');
    expect(
      await fs.readFile(
        document.versions.find((version) => version.number === 2)!.snapshotPath,
        'utf8',
      ),
    ).toBe('Version two');
  });

  it('does not republish a request or save a document without an explicit request', async () => {
    const { scope } = await request({});
    await publication.scan(scope);
    expect(
      deliverables.board('p', 'r').deliverables[0].documents[0]
        .currentVersionNumber,
    ).toBe(1);
    await fs.writeFile(
      path.join(scope.directory, 'temporary.txt'),
      'Not a retained document',
    );
    await publication.scan(scope);
    expect(deliverables.board('p', 'r').deliverables[0].documents).toHaveLength(
      1,
    );
  });

  it('restores the retained source if writing the new snapshot fails', async () => {
    await request({});
    const original = deliverables.board('p', 'r').deliverables[0].documents[0];
    const copy = fs.copyFile;
    const failure = vi
      .spyOn(fs, 'copyFile')
      .mockImplementation(async (source, target, mode) => {
        if (String(target).includes(`${path.sep}history${path.sep}`))
          throw new Error('Simulated storage failure');
        return copy(source, target, mode);
      });
    try {
      const { result, scope } = await request(
        { requestId: 'failed-v2', documentId: original.id, expectedVersion: 1 },
        'Version two',
      );
      expect(result.status).toBe('failed');
      expect(await fs.readFile(original.sourcePath, 'utf8')).toBe(
        'Version one',
      );
      expect(
        await fs.readFile(path.join(scope.directory, 'report.docx'), 'utf8'),
      ).toBe('Version two');
      expect(
        deliverables.board('p', 'r').deliverables[0].documents[0]
          .currentVersionNumber,
      ).toBe(1);
    } finally {
      failure.mockRestore();
    }
  });

  it('serializes concurrent saves and preserves the losing draft', async () => {
    await request({});
    const original = deliverables.board('p', 'r').deliverables[0].documents[0];
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'agent-2',
        projectId: 'p',
        workspacePath: root,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    await publication.prepare('agent-2', 'Second writer');
    const scopes = [
      publication['scopes'].get('agent')!,
      publication['scopes'].get('agent-2')!,
    ];
    for (const [index, scope] of scopes.entries()) {
      await fs.writeFile(
        path.join(scope.directory, 'report.docx'),
        `Candidate ${index}`,
      );
      await fs.writeFile(
        path.join(scope.directory, 'publication-request.json'),
        JSON.stringify({
          requestId: `concurrent-${index}`,
          resourceId: 'r',
          deliverableId: item.id,
          documentId: original.id,
          expectedVersion: 1,
          file: 'report.docx',
          comment: 'Concurrent update',
        }),
      );
    }
    await Promise.all(scopes.map((scope) => publication.scan(scope)));
    const statuses = await Promise.all(
      scopes.map(
        async (scope) =>
          (
            JSON.parse(
              await fs.readFile(
                path.join(scope.directory, 'publication-result.json'),
                'utf8',
              ),
            ) as Record<string, unknown>
          ).status,
      ),
    );
    expect(statuses.sort()).toEqual(['failed', 'published']);
    const document = deliverables.board('p', 'r').deliverables[0].documents[0];
    expect(document.currentVersionNumber).toBe(2);
    expect(
      await fs.readFile(
        document.versions.find((version) => version.number === 1)!.snapshotPath,
        'utf8',
      ),
    ).toBe('Version one');
    expect(await fs.readFile(document.sourcePath, 'utf8')).toBe(
      await fs.readFile(
        document.versions.find((version) => version.number === 2)!.snapshotPath,
        'utf8',
      ),
    );
  });

  it('refuses a foreign board and preserves the draft', async () => {
    const { scope, result } = await request({ resourceId: 'foreign-board' });
    expect(result.status).toBe('failed');
    expect(
      await fs.readFile(path.join(scope.directory, 'report.docx'), 'utf8'),
    ).toBe('Version one');
    expect(deliverables.board('p', 'r').deliverables[0].documents).toHaveLength(
      0,
    );
  });

  it('refuses symlinks and hardlinks instead of copying server files', async () => {
    await publication.prepare('agent');
    const scope = publication['scopes'].get('agent')!;
    const secret = path.join(root, 'secret.docx');
    await fs.writeFile(secret, 'Must not be retained');
    for (const [index, link] of [fs.symlink, fs.link].entries()) {
      const draft = path.join(scope.directory, `linked-${index}.docx`);
      await link(secret, draft);
      await fs.writeFile(
        path.join(scope.directory, 'publication-request.json'),
        JSON.stringify({
          requestId: `unsafe-${index}`,
          resourceId: 'r',
          deliverableId: item.id,
          file: path.basename(draft),
          comment: '',
        }),
      );
      await publication.scan(scope);
      expect(
        (
          JSON.parse(
            await fs.readFile(
              path.join(scope.directory, 'publication-result.json'),
              'utf8',
            ),
          ) as Record<string, unknown>
        ).status,
      ).toBe('failed');
    }
    expect(deliverables.board('p', 'r').deliverables[0].documents).toHaveLength(
      0,
    );
  });

  async function legacyProjection() {
    await request({});
    let document = deliverables.board('p', 'r').deliverables[0].documents[0];
    await request(
      { requestId: 'v2', documentId: document.id, expectedVersion: 1 },
      'Version two',
    );
    document = deliverables.board('p', 'r').deliverables[0].documents[0];
    const target = document.sourcePath;
    const old = path.join(
      root,
      'livrables',
      item.id,
      'published',
      document.id,
      'report.docx',
    );
    await fs.mkdir(path.dirname(old), { recursive: true });
    await fs.rename(target, old);
    database.db
      .update(documents)
      .set({ sourcePath: old })
      .where(eq(documents.id, document.id))
      .run();
    database.db
      .update(versions)
      .set({ sourcePath: old })
      .where(eq(versions.documentId, document.id))
      .run();
    const history = database.db.select().from(versions).all();
    return { document, old, target, history };
  }

  it('migrates existing projections without changing document identity or historical rows, and preserves old links', async () => {
    const { document, old, target, history } = await legacyProjection();
    const warn = vi.fn();
    expect(await migrateDeliverableDocumentRoots(database.db, warn)).toEqual({
      migrated: 1,
      blocked: 0,
    });
    expect(warn).not.toHaveBeenCalled();
    expect(await fs.readFile(target, 'utf8')).toBe('Version two');
    await expect(fs.stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(root, 'livrables', item.id, 'published')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(database.db.select().from(versions).all()).toEqual(history);
    expect(await files.resolveSafePath(old)).toBe(target);
    expect(deliverables.onlyOfficeHistory(old)?.document).toMatchObject({
      id: document.id,
      sourcePath: target,
      currentVersionNumber: 2,
    });
    expect(deliverables.onlyOfficeAccess(old)).toMatchObject({
      editable: true,
    });
    for (const version of history)
      expect(await fs.readFile(version.snapshotPath, 'utf8')).toBe(
        version.number === 1 ? 'Version one' : 'Version two',
      );
    expect(await migrateDeliverableDocumentRoots(database.db, warn)).toEqual({
      migrated: 0,
      blocked: 0,
    });
    const next = await request(
      { requestId: 'v3', documentId: document.id, expectedVersion: 2 },
      'Version three',
    );
    expect(next.result.status).toBe('published');
    expect(await fs.readFile(await files.resolveSafePath(old), 'utf8')).toBe(
      'Version three',
    );
    expect(
      deliverables
        .onlyOfficeHistory(old)
        ?.versions.map((version) => version.number),
    ).toEqual([1, 2, 3]);
  });

  it('refuses collisions without overwriting either file or losing history', async () => {
    const { old, target, history } = await legacyProjection();
    await fs.writeFile(target, 'Unrelated user file');
    expect(await migrateDeliverableDocumentRoots(database.db, vi.fn())).toEqual(
      { migrated: 0, blocked: 1 },
    );
    expect(await fs.readFile(target, 'utf8')).toBe('Unrelated user file');
    expect(await fs.readFile(old, 'utf8')).toBe('Version two');
    expect(database.db.select().from(documents).get()?.sourcePath).toBe(old);
    expect(database.db.select().from(versions).all()).toEqual(history);
  });

  it('resumes an interrupted copy without overwriting an identical destination', async () => {
    const { old, target } = await legacyProjection();
    await fs.copyFile(old, target);
    expect(await migrateDeliverableDocumentRoots(database.db, vi.fn())).toEqual(
      { migrated: 1, blocked: 0 },
    );
    expect(await files.resolveSafePath(old)).toBe(target);
  });

  it('keeps historical restoration functional after moving the current source', async () => {
    const { document, old, target, history } = await legacyProjection();
    await migrateDeliverableDocumentRoots(database.db, vi.fn());
    const first = history.find((version) => version.number === 1)!;
    const restored = await deliverables.restoreDocumentVersion(
      'p',
      'r',
      item.id,
      document.id,
      first.id,
      { expectedVersion: 2 },
      { personId: null, name: 'Alice' },
    );
    expect(restored.version.number).toBe(3);
    expect(
      database.db
        .select()
        .from(versions)
        .where(eq(versions.id, restored.version.id))
        .get()?.restoredFromVersionId,
    ).toBe(first.id);
    expect(await fs.readFile(target, 'utf8')).toBe('Version one');
    expect(await fs.readFile(await files.resolveSafePath(old), 'utf8')).toBe(
      'Version one',
    );
    for (const version of history)
      expect(await fs.readFile(version.snapshotPath, 'utf8')).toBe(
        version.number === 1 ? 'Version one' : 'Version two',
      );
  });

  it('refuses ambiguous names even when neither target exists yet', async () => {
    const { document, old } = await legacyProjection();
    const duplicate = path.join(
      path.dirname(path.dirname(old)),
      'another-document',
      document.name,
    );
    await fs.mkdir(path.dirname(duplicate));
    await fs.copyFile(old, duplicate);
    const original = database.db.select().from(documents).get()!;
    database.db
      .insert(documents)
      .values({ ...original, id: 'duplicate', sourcePath: duplicate })
      .run();
    expect(await migrateDeliverableDocumentRoots(database.db, vi.fn())).toEqual(
      { migrated: 0, blocked: 2 },
    );
    expect(await fs.readFile(old, 'utf8')).toBe('Version two');
    expect(await fs.readFile(duplicate, 'utf8')).toBe('Version two');
  });

  it('refuses hardlinked sources and preserves the missing-source metadata', async () => {
    const { old, history } = await legacyProjection();
    const other = path.join(root, 'linked.docx');
    await fs.link(old, other);
    expect(await migrateDeliverableDocumentRoots(database.db, vi.fn())).toEqual(
      { migrated: 0, blocked: 1 },
    );
    await fs.unlink(old);
    expect(await migrateDeliverableDocumentRoots(database.db, vi.fn())).toEqual(
      { migrated: 0, blocked: 1 },
    );
    expect(database.db.select().from(documents).get()?.sourcePath).toBe(old);
    expect(database.db.select().from(versions).all()).toEqual(history);
    expect(await fs.readFile(other, 'utf8')).toBe('Version two');
  });

  it('preserves unrelated files in old projection folders during cleanup', async () => {
    const { old } = await legacyProjection();
    const extra = path.join(path.dirname(old), 'notes.txt');
    await fs.writeFile(extra, 'Keep');
    expect(await migrateDeliverableDocumentRoots(database.db, vi.fn())).toEqual(
      { migrated: 1, blocked: 0 },
    );
    expect(await fs.readFile(extra, 'utf8')).toBe('Keep');
  });

  it('resumes cleanup after the database pointer was already committed', async () => {
    const { old, target, document, history } = await legacyProjection();
    await fs.copyFile(old, target);
    database.db
      .update(documents)
      .set({ sourcePath: target, previousSourcePaths: [old] })
      .where(eq(documents.id, document.id))
      .run();
    expect(await migrateDeliverableDocumentRoots(database.db, vi.fn())).toEqual(
      { migrated: 0, blocked: 0 },
    );
    await expect(fs.stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await files.resolveSafePath(old)).toBe(target);
    expect(database.db.select().from(versions).all()).toEqual(history);
  });

  it('checks permission on both the old link and its current target', async () => {
    const { old, target } = await legacyProjection();
    await migrateDeliverableDocumentRoots(database.db, vi.fn());
    const identities = new IdentityService(database.db);
    const check = vi
      .spyOn(identities, 'requireWorkspacePath')
      .mockImplementation((input) => {
        if (input === target) throw new Error('Current target denied');
      });
    await expect(
      accessContext.run(
        {
          identity: {
            kind: 'person',
            personId: 'reader',
            role: 'user',
            name: 'Reader',
            active: true,
          },
          identities,
        },
        () => files.resolveSafePath(old),
      ),
    ).rejects.toThrow('Current target denied');
    expect(check.mock.calls.map((call) => call[0])).toEqual([old, target]);
  });

  it('refuses symbolic links in a destination and preserves both sources', async () => {
    const { old, target } = await legacyProjection();
    const unrelated = path.join(root, 'other.docx');
    await fs.writeFile(unrelated, 'Version two');
    await fs.symlink(unrelated, target);
    expect(await migrateDeliverableDocumentRoots(database.db, vi.fn())).toEqual(
      { migrated: 0, blocked: 1 },
    );
    expect(await fs.readFile(old, 'utf8')).toBe('Version two');
    expect(await fs.readFile(unrelated, 'utf8')).toBe('Version two');
  });

  it('does not delete the deliverable directory or sibling files when saving a new projection fails', async () => {
    const folder = path.join(root, 'livrables', item.id);
    const sibling = path.join(folder, 'keep.txt');
    await fs.writeFile(sibling, 'Keep');
    const transaction = vi
      .spyOn(database.db, 'transaction')
      .mockImplementationOnce(() => {
        throw new Error('Simulated database failure');
      });
    const result = await request({});
    transaction.mockRestore();
    expect(result.result.status).toBe('failed');
    expect(await fs.readFile(sibling, 'utf8')).toBe('Keep');
    await expect(
      fs.stat(path.join(folder, 'report.docx')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(folder)).isDirectory()).toBe(true);
  });

  it('refuses to overwrite an unrelated root file when publishing a new document', async () => {
    const target = path.join(root, 'livrables', item.id, 'report.docx');
    await fs.writeFile(target, 'Unrelated root file');
    expect((await request({})).result.status).toBe('failed');
    expect(await fs.readFile(target, 'utf8')).toBe('Unrelated root file');
    expect(database.db.select().from(documents).all()).toHaveLength(0);
    expect(database.db.select().from(versions).all()).toHaveLength(0);
  });

  it('does not provide a writer when the project has no deliverables manager', async () => {
    database.db.delete(projectResources).run();
    const prepared = await publication.prepare('agent');
    expect(prepared?.context).toContain('no deliverables manager');
    expect(publication['scopes'].size).toBe(0);
  });
});
