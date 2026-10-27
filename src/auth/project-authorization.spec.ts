import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase, TestDatabase } from '../database/database.testing';
import { DRIZZLE_DB } from '../database/database.constants';
import {
  people,
  projects,
  projectParticipants,
  projectWorkspaces,
  projectAgentThreads,
  simpleChatThreads,
  settings,
  conversationBranchEdges,
  projectResources,
  projectDeliverables,
  projectDeliverableVersions,
} from '../database/schema';
import { IdentityService, PlatformIdentity } from './identity.service';
import { AuthService } from './auth.service';
import { ApiKeyGuard } from './api-key.guard';
import { PlatformAccessGuard } from './platform-access.guard';
import { AccessContextInterceptor } from './access-context.interceptor';
import { accessContext } from './access-context';
import { ProjectsController } from '../projects/projects.controller';
import { ProjectsService } from '../projects/projects.service';
import { ProjectWorkspaceLayout } from '../projects/project-workspace-layout';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { WORKSPACE_LAYOUT_VERSION } from '../projects/workspace-structure';
import { SimpleChatController } from '../simple-chat/simple-chat.controller';
import { SimpleChatService } from '../simple-chat/simple-chat.service';
import { FilesController } from '../files/files.controller';
import { FilesService } from '../files/files.service';
import { SettingsService } from '../settings/settings.service';
import {
  SECURITY_SETTING_KEYS,
  FILES_SETTING_KEYS,
} from '../settings/settings.definitions';
import { ThreadsService } from '../threads/threads.service';
import { ThreadMetadataService } from '../threads/thread-metadata.service';
import { GitMutationGateService } from '../threads/git-mutation-gate.service';
import { OnlyOfficeController } from '../onlyoffice/onlyoffice.controller';
import { DeliverablesController } from '../deliverables/deliverables.controller';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { sign } from 'jsonwebtoken';
import { projectSystemPath } from '../projects/workspace-structure';

let app: NestFastifyApplication;
let database: TestDatabase;
let identities: IdentityService;
let service: ProjectsService;
let root: string;
let files: FilesService;
const headers = (person = 'alice') => ({
  authorization: 'Bearer project-isolation-test',
  'x-webui-auth-source': 'authentik',
  'x-webui-auth-subject': person,
  'x-webui-auth-email': `${person}@example.com`,
});
const person = (id: string): PlatformIdentity =>
  identities.resolve(headers(id));
const asPerson = <T>(id: string, action: () => T): T =>
  accessContext.run({ identity: person(id), identities }, action);

beforeEach(async () => {
  vi.stubEnv('WEBUI_REQUIRE_IDENTITY', 'true');
  root = mkdtempSync(join(tmpdir(), 'project-isolation-'));
  database = createTestDatabase();
  const now = Date.now();
  for (const id of ['alice', 'bob', 'outsider', 'admin'])
    database.db
      .insert(people)
      .values({
        id,
        reference: id,
        name: id,
        firstName: id === 'alice' ? 'Alice' : id,
        lastName: 'Example',
        email: `${id}@example.com`,
        identitySubject: id,
        role: id === 'admin' ? 'administrator' : 'standard',
        active: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  for (const id of ['a', 'b']) {
    const path = await new ProjectWorkspaceLayout(database.db, root).prepare(
      id,
    );
    writeFileSync(join(path, 'document.txt'), `confidential-${id}`);
    database.db
      .insert(projects)
      .values({
        id,
        name: `Project ${id}`,
        workspacePath: path,
        workspaceLayoutVersion: WORKSPACE_LAYOUT_VERSION,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectWorkspaces)
      .values({
        id,
        projectId: id,
        name: 'Principal',
        path,
        primary: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectParticipants)
      .values({
        projectId: id,
        personId: id === 'a' ? 'alice' : 'bob',
        createdAt: now,
      })
      .run();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: `agent-${id}`,
        projectId: id,
        workspacePath: path,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(simpleChatThreads)
      .values({
        id: `chat-${id}`,
        title: `Conversation ${id}`,
        projectId: id,
        cwd: path,
        model: 'test',
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  database.db
    .insert(simpleChatThreads)
    .values({
      id: 'legacy',
      title: 'Unknown owner',
      cwd: join(root, 'a'),
      model: 'test',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  identities = new IdentityService(database.db);
  const configuration = {
    getStringSetting: (key: string) =>
      key === SECURITY_SETTING_KEYS.workspaceRoots
        ? root
        : key === 'general.onlyofficeUrl'
          ? 'http://office.test'
          : key === 'general.onlyofficeJwtSecret'
            ? 'office-test-secret'
            : null,
    getNumberSetting: () => 1048576,
    getSetting: (key: string) => ({
      value: key === FILES_SETTING_KEYS.excludedDirs ? '' : null,
    }),
    onChange: () => () => undefined,
  } as unknown as SettingsService;
  files = new FilesService(configuration, database.db);
  const metadata = {
    read: () => Promise.resolve({ entries: [], freshness: 'fresh' }),
  };
  service = new ProjectsService(
    files,
    {} as never,
    metadata as never,
    { applyToThreads: (threads: unknown[]) => threads } as never,
    {} as never,
    {} as never,
    {} as never,
    database.db,
  );
  const module = await Test.createTestingModule({
    imports: [JwtModule.register({})],
    controllers: [
      ProjectsController,
      SimpleChatController,
      FilesController,
      OnlyOfficeController,
      DeliverablesController,
    ],
    providers: [
      ActiveFoldersService,
      IdentityService,
      AuthService,
      DeliverablesService,
      { provide: DRIZZLE_DB, useValue: database.db },
      {
        provide: ConfigService,
        useValue: new ConfigService({
          WEBUI_API_KEY: 'project-isolation-test',
        }),
      },
      { provide: ProjectsService, useValue: service },
      { provide: FilesService, useValue: files },
      { provide: SettingsService, useValue: configuration },
      {
        provide: SimpleChatService,
        useValue: new SimpleChatService(database.db, {} as never, {} as never),
      },
      { provide: ThreadsService, useValue: {} },
      { provide: ThreadMetadataService, useValue: {} },
      { provide: GitMutationGateService, useValue: {} },
      { provide: APP_GUARD, useClass: ApiKeyGuard },
      { provide: APP_GUARD, useClass: PlatformAccessGuard },
      { provide: APP_INTERCEPTOR, useClass: AccessContextInterceptor },
    ],
  }).compile();
  app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  app.setGlobalPrefix('api');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterEach(async () => {
  await app?.close();
  database?.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(['alice', 'bob', 'outsider', 'admin'])(
  'filters project lists and dashboard for %s before returning data',
  async (id) => {
    const expected =
      id === 'admin'
        ? ['a', 'b']
        : id === 'outsider'
          ? []
          : [id === 'alice' ? 'a' : 'b'];
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: headers(id),
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ projects: { id: string }[] }>().projects.map((p) => p.id),
    ).toEqual(expected);
    const dashboard = await app.inject({
      method: 'GET',
      url: '/api/projects/dashboard',
      headers: headers(id),
    });
    expect(dashboard.statusCode).toBe(200);
    expect(
      dashboard
        .json<{ projects: { id: string }[] }>()
        .projects.map((p) => p.id),
    ).toEqual(expected);
  },
);

it('denies direct project writes and moves to an unauthorized project without changing rows', async () => {
  const create = await app.inject({
    method: 'POST',
    url: '/api/projects/a/resources',
    headers: headers('admin'),
    payload: { type: 'task_board' },
  });
  const resourceId = create.json<{ resource: { id: string } }>().resource.id;
  const own = await app.inject({
    method: 'GET',
    url: `/api/projects/a/resources/${resourceId}`,
    headers: headers(),
  });
  expect(own.statusCode).toBe(200);
  for (const [method, url, payload] of [
    ['PATCH', '/api/projects/b', { name: 'stolen' }],
    ['POST', '/api/projects/b/resources', { type: 'task_board' }],
    ['PATCH', `/api/projects/a/resources/${resourceId}`, { projectId: 'b' }],
  ] as const) {
    expect(
      (await app.inject({ method, url, payload, headers: headers() }))
        .statusCode,
    ).toBe(403);
  }
  expect(
    database.db.select().from(projects).where(eq(projects.id, 'b')).get()?.name,
  ).toBe('Project b');
});

it('filters simple chats and rejects guessed IDs, forged project IDs and unknown legacy owners', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/simple-chat/threads',
    headers: headers(),
  });
  expect(
    response.json<{ threads: { id: string }[] }>().threads.map((t) => t.id),
  ).toEqual(['chat-a']);
  for (const id of ['chat-b', 'legacy']) {
    for (const method of ['GET', 'PATCH', 'DELETE'] as const)
      expect(
        (
          await app.inject({
            method,
            url: `/api/simple-chat/threads/${id}`,
            headers: headers(),
            ...(method === 'PATCH' ? { payload: { title: 'stolen' } } : {}),
          })
        ).statusCode,
      ).toBe(403);
  }
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/simple-chat/threads',
        headers: headers(),
        payload: { projectId: 'b' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/simple-chat/threads/legacy',
        headers: headers('admin'),
      })
    ).statusCode,
  ).toBe(200);
  expect(
    database.db
      .select()
      .from(simpleChatThreads)
      .where(eq(simpleChatThreads.id, 'legacy'))
      .get()?.projectId,
  ).toBeNull();
});

it('reserves raw system files for administrators, including guessed old URLs and symbolic links', async () => {
  const system = projectSystemPath(join(root, 'a'));
  const file = join(system, 'history/admin.txt');
  writeFileSync(file, 'ADMIN_ONLY');
  symlinkSync(system, join(root, 'a/system-link'));
  for (const target of [
    file,
    join(root, 'a/.mergeron/history/admin.txt'),
    join(root, 'a/system-link/history/admin.txt'),
  ]) {
    const response = await app.inject({
      url: `/api/files/read?path=${encodeURIComponent(target)}`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('ADMIN_ONLY');
  }
  const administrator = await app.inject({
    url: `/api/files/read?path=${encodeURIComponent(file)}`,
    headers: headers('admin'),
  });
  expect(administrator.statusCode).toBe(200);
  expect(administrator.body).toContain('ADMIN_ONLY');
  const write = await app.inject({
    method: 'POST',
    url: '/api/files/write',
    headers: headers('admin'),
    payload: { path: file, content: 'forbidden' },
  });
  expect(write.statusCode).toBe(409);
  expect(readFileSync(file, 'utf8')).toBe('ADMIN_ONLY');
  const memberList = await app.inject({
    url: '/api/projects',
    headers: headers(),
  });
  expect(memberList.body).not.toContain('systemWorkspacePath');
  const adminList = await app.inject({
    url: '/api/projects',
    headers: headers('admin'),
  });
  expect(adminList.body).toContain('systemWorkspacePath');
});

it('checks file reads, writes, roots, copies and symlink targets against project membership', async () => {
  const a = join(root, 'a', 'document.txt');
  const b = join(root, 'b', 'document.txt');
  expect(
    (
      await app.inject({
        url: `/api/files/read?path=${encodeURIComponent(a)}`,
        headers: headers(),
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        url: `/api/files/read?path=${encodeURIComponent(b)}`,
        headers: headers(),
      })
    ).statusCode,
  ).toBe(403);
  const roots = await app.inject({
    url: '/api/files/roots',
    headers: headers(),
  });
  expect(roots.json<{ roots: string[] }>().roots).toEqual([join(root, 'a')]);
  for (const [url, payload] of [
    ['/api/files/write', { path: b, content: 'stolen' }],
    [
      '/api/files/copy',
      { sourcePath: b, destinationPath: join(root, 'a', 'copy.txt') },
    ],
    [
      '/api/files/copy',
      { sourcePath: a, destinationPath: join(root, 'b', 'copy.txt') },
    ],
  ] as const)
    expect(
      (await app.inject({ method: 'POST', url, payload, headers: headers() }))
        .statusCode,
    ).toBe(403);
  const link = join(root, 'a', 'shortcut');
  symlinkSync(join(root, 'b'), link);
  expect(
    (
      await app.inject({
        url: `/api/files/read?path=${encodeURIComponent(join(link, 'document.txt'))}`,
        headers: headers(),
      })
    ).statusCode,
  ).toBe(403);
  expect(readFileSync(b, 'utf8')).toBe('confidential-b');
});

it('blocks indirect Codex planning and simple-chat execution before any process is started', async () => {
  const create = await app.inject({
    method: 'POST',
    url: '/api/projects/a/resources',
    headers: headers('admin'),
    payload: { type: 'task_board' },
  });
  const resourceId = create.json<{ resource: { id: string } }>().resource.id;
  for (const action of ['ai-plan', 'ai-replan', 'ai-advice'])
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/projects/a/resources/${resourceId}/${action}`,
          headers: headers(),
          payload: { prompt: 'test' },
        })
      ).statusCode,
    ).toBe(403);
  database.db
    .insert(settings)
    .values({
      key: 'simple-chat:backend',
      value: 'codex',
      type: 'string',
      category: 'simple-chat',
      description: '',
      defaultValue: 'openai',
      constraints: '{}',
      updatedAt: 1,
    })
    .run();
  const response = await app.inject({
    method: 'POST',
    url: '/api/simple-chat/threads/chat-a/messages',
    headers: headers(),
    payload: { message: 'test' },
  });
  expect(response.statusCode).toBe(403);
});

it('enforces the same policy inside domain services and isolates concurrent requests', async () => {
  await Promise.all(
    ['alice', 'bob'].map((id) =>
      asPerson(id, async () => {
        await Promise.resolve();
        expect(service.get(id === 'alice' ? 'a' : 'b').id).toBe(
          id === 'alice' ? 'a' : 'b',
        );
        expect(() => service.get(id === 'alice' ? 'b' : 'a')).toThrow(
          'Project participant',
        );
      }),
    ),
  );
});

it('requires access to inherited messages when a branch crosses project boundaries', () => {
  database.db
    .insert(conversationBranchEdges)
    .values({
      childThreadId: 'agent-a',
      parentThreadId: 'agent-b',
      treeRootThreadId: 'agent-b',
      forkBeforeTurnId: 'turn',
      commonPrefixTurnId: 'turn',
      inheritedTurnIds: '[]',
      createdAt: 1,
    })
    .run();
  expect(identities.canReadThread(person('alice'), 'agent-a')).toBe(false);
  expect(identities.canReadThread(person('admin'), 'agent-a')).toBe(true);
});

it('keeps private conversations visible only to their known owner and administrators', () => {
  identities.recordConversationOwner(person('alice'), 'legacy', 'simple');
  expect(identities.canReadThread(person('alice'), 'legacy', 'simple')).toBe(
    true,
  );
  expect(identities.canReadThread(person('bob'), 'legacy', 'simple')).toBe(
    false,
  );
  expect(identities.canReadThread(person('admin'), 'legacy', 'simple')).toBe(
    true,
  );
});

it('revokes file and editing capabilities on removal, including after rejoining', async () => {
  const path = join(root, 'a', 'document.txt');
  const auth = app.get(AuthService);
  const session = asPerson('alice', () =>
    auth.createDocumentSession(path, true),
  );
  const token = auth.signFileAccess(path, session);
  expect(auth.verifyFileAccess(token, path)).toBe(true);
  expect(auth.verifyDocumentSession(session, path, true)).toBe(true);
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: '/api/projects/a/participants/alice',
        headers: headers('admin'),
      })
    ).statusCode,
  ).toBe(200);
  expect(auth.verifyFileAccess(token, path)).toBe(false);
  expect(auth.verifyDocumentSession(session, path, true)).toBe(false);
  database.db
    .insert(projectParticipants)
    .values({ projectId: 'a', personId: 'alice', createdAt: 2 })
    .run();
  expect(auth.verifyFileAccess(token, path)).toBe(false);
});

it('rechecks disabled accounts and rejects standard-user document sessions after role changes', () => {
  const path = join(root, 'a', 'document.txt');
  const session = asPerson('alice', () =>
    identities.createDocumentSession(person('alice'), path, true),
  );
  const stale = person('alice');
  database.db
    .update(people)
    .set({ active: false })
    .where(eq(people.id, 'alice'))
    .run();
  expect(identities.canReadProject(stale, 'a')).toBe(false);
  expect(identities.verifyDocumentSession(session, path, true)).toBe(false);
});

it('refuses ambiguous legacy workspace overlaps rather than exposing a nested project', () => {
  database.db
    .update(projectWorkspaces)
    .set({ path: root })
    .where(eq(projectWorkspaces.id, 'a'))
    .run();
  expect(() =>
    identities.requireWorkspacePath(root, false, person('alice')),
  ).toThrow('ambiguous');
  expect(() =>
    identities.requireWorkspacePath(
      join(root, 'b', 'document.txt'),
      false,
      person('alice'),
    ),
  ).toThrow();
});

it('refuses a new primary workspace nested inside another project', async () => {
  await expect(
    new ProjectWorkspaceLayout(database.db, join(root, 'a')).prepare(
      'new-project',
    ),
  ).rejects.toThrow('cannot overlap');
});

it('does not expose deliverable snapshot metadata or bytes from an unauthorized source project', async () => {
  database.db
    .insert(projectResources)
    .values({
      id: 'deliverables',
      projectId: 'a',
      name: 'Deliverables',
      type: 'deliverable_board',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(projectDeliverables)
    .values({
      id: 'output',
      resourceId: 'deliverables',
      title: 'Shared output',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(projectDeliverableVersions)
    .values({
      id: 'snapshot',
      deliverableId: 'output',
      number: 1,
      note: 'History',
      createdAt: 1,
      files: [
        {
          name: 'confidential-b.txt',
          sourcePath: join(root, 'b', 'document.txt'),
          snapshotPath: join(root, 'a', '.mergeron', 'snapshot'),
          size: 14,
          sha256: 'unused',
        },
      ],
    })
    .run();
  const base = '/api/projects/a/resources/deliverables/deliverables';
  const member = await app.inject({ url: base, headers: headers() });
  expect(member.statusCode).toBe(200);
  expect(member.body).not.toContain('confidential-b.txt');
  expect(
    member.json<{ deliverables: { versions: unknown[] }[] }>().deliverables[0]
      .versions,
  ).toEqual([]);
  const admin = await app.inject({ url: base, headers: headers('admin') });
  expect(admin.statusCode).toBe(200);
  expect(admin.body).toContain('confidential-b.txt');
  const download = await app.inject({
    url: `${base}/output/versions/snapshot/files/0`,
    headers: headers(),
  });
  expect(download.statusCode).toBe(403);
});

it('checks live OnlyOffice download and save callbacks, including readonly and revoked sessions', async () => {
  const path = join(root, 'a', 'office.docx');
  writeFileSync(path, 'original');
  database.db
    .insert(projectResources)
    .values({
      id: 'office-board',
      projectId: 'a',
      type: 'deliverable_board',
      name: 'Deliverables',
      config: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  database.db
    .insert(projectDeliverables)
    .values({
      id: 'office-deliverable',
      resourceId: 'office-board',
      title: 'Office document',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/projects/a/resources/office-board/deliverables/office-deliverable/documents',
        headers: headers(),
        payload: { path },
      })
    ).statusCode,
  ).toBe(201);
  const loadConfig = async (mode: string) => {
    const response = await app.inject({
      url: `/api/onlyoffice/config?path=${encodeURIComponent(path)}&mode=${mode}`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    return response.json<{
      config: {
        type: string;
        document: {
          key: string;
          url: string;
          permissions: Record<string, boolean>;
        };
        editorConfig: {
          mode: string;
          embedded?: { autostart: string; toolbarDocked: string };
          callbackUrl: string;
          lang: string;
          user: { id: string; name: string };
        };
      };
    }>().config;
  };
  const callback = async (editor: Awaited<ReturnType<typeof loadConfig>>) => {
    const payload = {
      key: editor.document.key,
      status: 2,
      url: 'http://office.test/saved.docx',
      changesurl: 'http://office.test/changes.zip',
      history: {
        changes: { serverVersion: '10.0', changes: [] },
        serverVersion: '10.0.0',
      },
    };
    const url = new URL(editor.editorConfig.callbackUrl);
    return app.inject({
      method: 'POST',
      url: url.pathname + url.search,
      payload: { ...payload, token: sign(payload, 'office-test-secret') },
    });
  };
  const editable = await loadConfig('edit');
  expect(editable.editorConfig.lang).toBe('fr');
  expect(editable.editorConfig.user).toEqual({
    id: 'alice',
    name: 'Alice Example',
  });
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('edited'))
    .mockResolvedValueOnce(new Response('changes'));
  expect((await callback(editable)).json()).toEqual({ error: 0 });
  expect(readFileSync(path, 'utf8')).toBe('edited');
  const history = await app.inject({
    url: `/api/onlyoffice/history?path=${encodeURIComponent(path)}`,
    headers: headers(),
  });
  expect(history.statusCode).toBe(200);
  const historyBody = history.json<{
    currentVersion: number;
    history: Array<{ key: string }>;
  }>();
  expect(historyBody).toMatchObject({
    currentVersion: 2,
    history: [
      { version: 1 },
      {
        version: 2,
        serverVersion: '10.0.0',
        user: { id: 'alice', name: 'alice' },
      },
    ],
  });
  expect(historyBody.history[1].key).not.toBe(editable.document.key);
  const view = await loadConfig('view');
  expect(view.type).toBe('embedded');
  expect(view.editorConfig.mode).toBe('view');
  expect(view.editorConfig.embedded).toEqual({
    autostart: 'document',
    toolbarDocked: 'top',
  });
  expect(view.document.permissions).toMatchObject({
    edit: false,
    comment: false,
    review: false,
    fillForms: false,
    download: false,
    print: false,
  });
  expect(historyBody.history[1].key).toBe(view.document.key);
  expect((await callback(view)).json()).toEqual({ error: 1 });
  expect(fetch).toHaveBeenCalledTimes(2);
  const url = new URL(editable.document.url);
  const transferHeaders = {
    authorization: 'Bearer project-isolation-test',
    'x-webui-auth-source': 'document',
  };
  const historyData = await app.inject({
    url: `/api/onlyoffice/history-data?path=${encodeURIComponent(path)}&version=2`,
    headers: headers(),
  });
  expect(historyData.statusCode).toBe(200);
  const historical = historyData.json<{
    url: string;
    changesUrl: string;
    previous: { url: string };
  }>();
  const historyUrls = [
    historical.url,
    historical.changesUrl,
    historical.previous.url,
  ].map((item) => {
    const parsed = new URL(item);
    return parsed.pathname + parsed.search;
  });
  for (const historicalUrl of historyUrls) {
    expect(
      (await app.inject({ url: historicalUrl, headers: transferHeaders }))
        .statusCode,
    ).toBe(200);
  }
  expect(
    (
      await app.inject({
        url: url.pathname + url.search,
        headers: transferHeaders,
      })
    ).statusCode,
  ).toBe(200);
  await app.inject({
    method: 'DELETE',
    url: '/api/projects/a/participants/alice',
    headers: headers('admin'),
  });
  for (const historicalUrl of historyUrls) {
    expect(
      (await app.inject({ url: historicalUrl, headers: transferHeaders }))
        .statusCode,
    ).toBe(403);
  }
  expect(
    (
      await app.inject({
        url: url.pathname + url.search,
        headers: transferHeaders,
      })
    ).statusCode,
  ).toBe(403);
  expect((await callback(editable)).json()).toEqual({ error: 1 });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(readFileSync(path, 'utf8')).toBe('edited');
});
