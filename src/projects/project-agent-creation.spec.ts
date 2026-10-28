import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projectAgentThreads,
  projectResources,
  projectDeliverables,
  projectWorkspaces,
  projects,
  projectWorkspaceCopies,
  projectGitCopyOwners,
  projectWorkspaceResources,
} from '../database/schema';
import { ThreadWorkspaceOverridesService } from '../threads/thread-workspace-overrides.service';
import { claimAgentCopy } from './git-copy-ownership';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { DeliverablesService } from '../deliverables/deliverables.service';
import type { FilesService } from '../files/files.service';
let database: TestDatabase, root: string, service: ProjectsService;
let folders: ActiveFoldersService, overrides: ThreadWorkspaceOverridesService;
const threads = {
  startThread: vi.fn(),
  rememberInitialThreadCwd: vi.fn(),
  setThreadCwd: vi.fn(),
  prepareThreadCwd: vi.fn(),
  archiveThread: vi.fn(),
};
const metadata = { invalidate: vi.fn() };
beforeEach(async () => {
  vi.resetAllMocks();
  database = createTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'project-agent-create-'));
  database.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'Project',
      workspacePath: root,
      workspaceLayoutVersion: 2,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(projectWorkspaces)
    .values({
      id: 'w',
      projectId: 'p',
      name: 'Principal',
      path: root,
      primary: true,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  threads.startThread.mockResolvedValue({
    thread: { id: 'new-agent' },
    cwd: root,
  });
  threads.rememberInitialThreadCwd.mockReturnValue(['new-agent']);
  threads.setThreadCwd.mockRejectedValue(new Error('no rollout found'));
  threads.prepareThreadCwd.mockResolvedValue(['new-agent']);
  threads.archiveThread.mockResolvedValue(undefined);
  folders = new ActiveFoldersService(database.db);
  overrides = new ThreadWorkspaceOverridesService(database.db);
  service = new ProjectsService(
    null as never,
    null as never,
    metadata as never,
    overrides,
    null as never,
    threads as never,
    null as never,
    database.db,
    folders,
  );
});
afterEach(async () => {
  database.sqlite.close();
  await rm(root, { recursive: true, force: true });
});
it('migrates existing projects to browser defaults and persists validated preferences', () => {
  expect(database.db.select().from(projects).get()?.browserSettings).toEqual({
    homeUrl: 'https://www.google.com',
    desktopSplit: true,
    allowPopups: true,
  });
  const settings = {
    homeUrl: 'https://example.org/start',
    desktopSplit: false,
    allowPopups: false,
  };
  service.configureBrowser('p', settings);
  expect(database.db.select().from(projects).get()?.browserSettings).toEqual(
    settings,
  );
  for (const homeUrl of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://user:secret@example.org',
  ]) {
    expect(() =>
      service.configureBrowser('p', { ...settings, homeUrl }),
    ).toThrow('Invalid browser home URL');
  }
  expect(() =>
    service.configureBrowser('p', { ...settings, allowPopups: 'yes' }),
  ).toThrow('Invalid browser settings');
  expect(database.db.select().from(projects).get()?.browserSettings).toEqual(
    settings,
  );
});
it('creates and attaches a fresh agent before returning, without resuming its nonexistent rollout', async () => {
  const result = await service.createAgent('p', root);
  expect(result.thread.id).toBe('new-agent');
  expect(threads.startThread).toHaveBeenCalledWith({ cwd: root });
  expect(threads.rememberInitialThreadCwd).toHaveBeenCalledWith(
    'new-agent',
    root,
  );
  expect(threads.setThreadCwd).not.toHaveBeenCalled();
  expect(database.db.select().from(projectAgentThreads).get()).toMatchObject({
    threadId: 'new-agent',
    projectId: 'p',
    workspacePath: root,
  });
  expect(
    new ActiveFoldersService(database.db).get('agent', 'new-agent'),
  ).toMatchObject({ projectId: 'p', resourceId: 'w', effectivePath: root });
  expect(metadata.invalidate).toHaveBeenCalled();
  database.db
    .insert(projectResources)
    .values({
      id: 'board',
      projectId: 'p',
      type: 'deliverable_board',
      name: 'Deliverables',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(projectDeliverables)
    .values({
      id: 'd',
      resourceId: 'board',
      title: 'Report',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  const deliverables = new DeliverablesService(
    database.db,
    {} as FilesService,
    null as never,
    new ActiveFoldersService(database.db),
  );
  expect(deliverables.availableAgentIds('p', 'board', 'd')).toContain(
    'new-agent',
  );
});
it('validates the project folder before starting a native conversation', async () => {
  await expect(
    service.createAgent('p', join(root, '..', 'outside')),
  ).rejects.toThrow();
  expect(threads.startThread).not.toHaveBeenCalled();
  expect(database.db.select().from(projectAgentThreads).all()).toEqual([]);
});
it('does not report success if association fails and attempts to archive only the new agent', async () => {
  vi.spyOn(service, 'associateAgent').mockRejectedValue(
    new Error('association failed'),
  );
  await expect(service.createAgent('p', root)).rejects.toThrow(
    'association failed',
  );
  expect(threads.archiveThread).toHaveBeenCalledWith('new-agent');
  expect(database.db.select().from(projectAgentThreads).all()).toEqual([]);
});
it('rejects a malformed controller request before creating an agent', () => {
  const createAgent = vi.fn();
  const controller = new ProjectsController({ createAgent } as never);
  for (const body of [{}, { workspacePath: '' }, { workspacePath: 42 }])
    expect(() => controller.createAgent('p', body as never)).toThrow();
  expect(createAgent).not.toHaveBeenCalled();
});

async function addCopy() {
  const copyPath = join(root, 'copy');
  await mkdir(copyPath);
  database.db
    .insert(projectWorkspaceResources)
    .values({
      id: 'remote',
      projectId: 'p',
      type: 'git',
      name: 'Remote',
      address: 'https://example.invalid/repo.git',
      rootPath: '/',
      accessMode: 'read_write',
      capabilities: { read: true, write: true, execute: false },
      enabled: true,
      connectionState: 'connected',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(projectWorkspaces)
    .values({
      id: 'copy-workspace',
      projectId: 'p',
      name: 'Copy',
      path: copyPath,
      primary: false,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(projectWorkspaceCopies)
    .values({
      id: 'copy',
      projectId: 'p',
      sourceResourceId: 'remote',
      localWorkspaceId: 'copy-workspace',
      name: 'Copy',
      revision: 'abc',
      state: 'ready',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  await service.createAgent('p', root);
  return copyPath;
}

it('releases only the newly claimed copy on native failure and preserves active folder, membership and cwd', async () => {
  const copyPath = await addCopy();
  const membership = database.db.select().from(projectAgentThreads).all();
  const active = folders.get('agent', 'new-agent');
  threads.prepareThreadCwd.mockRejectedValueOnce(new Error('native failure'));
  await expect(
    service.associateAgent('p', 'new-agent', copyPath),
  ).rejects.toThrow('native failure');
  expect(database.db.select().from(projectGitCopyOwners).all()).toEqual([]);
  expect(database.db.select().from(projectAgentThreads).all()).toEqual(
    membership,
  );
  expect(folders.get('agent', 'new-agent')).toEqual(active);
  expect(overrides.get('new-agent')).toBeNull();
  // A normal retry can complete without manual database repair.
  await expect(
    service.associateAgent('p', 'new-agent', copyPath),
  ).resolves.toMatchObject({ workspacePath: copyPath });
  expect(overrides.get('new-agent')).toBe(copyPath);
  expect(folders.resolveAgent('new-agent')).toBe(copyPath);
  expect(database.db.select().from(projectGitCopyOwners).all()).toHaveLength(1);
});

it('preserves a clone’s pre-existing reservation when association fails, and allows it to be retried', async () => {
  const copyPath = await addCopy();
  claimAgentCopy(database.db, 'p', 'new-agent', 'copy');
  const previous = database.db.select().from(projectGitCopyOwners).all();
  threads.prepareThreadCwd.mockRejectedValueOnce(new Error('native failure'));
  await expect(
    service.associateAgent('p', 'new-agent', copyPath),
  ).rejects.toThrow();
  expect(database.db.select().from(projectGitCopyOwners).all()).toEqual(
    previous,
  );
  await service.associateAgent('p', 'new-agent', copyPath);
  expect(folders.resolveAgent('new-agent')).toBe(copyPath);
});

it('rolls back folder, membership and cwd together if final folder validation fails', async () => {
  const copyPath = await addCopy();
  const membership = database.db.select().from(projectAgentThreads).all();
  const active = folders.get('agent', 'new-agent');
  vi.spyOn(folders, 'set').mockImplementationOnce(() => {
    throw new Error('folder changed');
  });
  await expect(
    service.associateAgent('p', 'new-agent', copyPath),
  ).rejects.toThrow('folder changed');
  expect(overrides.get('new-agent')).toBeNull();
  expect(folders.get('agent', 'new-agent')).toEqual(active);
  expect(database.db.select().from(projectAgentThreads).all()).toEqual(
    membership,
  );
  expect(database.db.select().from(projectGitCopyOwners).all()).toEqual([]);
});

it('rejects a concurrent association for the same agent and releases its guard after failure', async () => {
  const copyPath = await addCopy();
  let fail!: (error: Error) => void;
  threads.prepareThreadCwd.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const first = service.associateAgent('p', 'new-agent', copyPath);
  await expect(
    service.associateAgent('p', 'new-agent', copyPath),
  ).rejects.toThrow('déjà en cours');
  fail(new Error('failed'));
  await expect(first).rejects.toThrow('failed');
  expect(database.db.select().from(projectGitCopyOwners).all()).toEqual([]);
  await expect(
    service.associateAgent('p', 'new-agent', copyPath),
  ).resolves.toMatchObject({ workspacePath: copyPath });
});
