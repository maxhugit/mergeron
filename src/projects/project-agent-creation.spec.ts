import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
} from '../database/schema';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { DeliverablesService } from '../deliverables/deliverables.service';
import type { FilesService } from '../files/files.service';
let database: TestDatabase, root: string, service: ProjectsService;
const threads = {
  startThread: vi.fn(),
  rememberInitialThreadCwd: vi.fn(),
  setThreadCwd: vi.fn(),
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
  threads.archiveThread.mockResolvedValue(undefined);
  service = new ProjectsService(
    null as never,
    null as never,
    metadata as never,
    null as never,
    null as never,
    threads as never,
    null as never,
    database.db,
    new ActiveFoldersService(database.db),
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
