import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projectActiveFolders,
  projectAgentThreads,
  projects,
  projectWorkspaces,
} from '../database/schema';
import { ActiveFoldersService } from './active-folders.service';
import { AgentProjectMembershipService } from './agent-project-membership.service';

let database: TestDatabase, root: string, folders: ActiveFoldersService;
let service: AgentProjectMembershipService;
beforeEach(() => {
  database = createTestDatabase();
  root = mkdtempSync(join(tmpdir(), 'agent-project-'));
  for (const id of ['p', 'q']) {
    const path = join(root, id);
    mkdirSync(path);
    database.db
      .insert(projects)
      .values({ id, name: id, workspacePath: path, createdAt: 1, updatedAt: 1 })
      .run();
    database.db
      .insert(projectWorkspaces)
      .values({
        id,
        projectId: id,
        name: id,
        path,
        primary: true,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  }
  folders = new ActiveFoldersService(database.db);
  service = new AgentProjectMembershipService(database.db, folders);
});
afterEach(() => {
  database.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});
it('rejects a missing or external project before creation', () => {
  expect(() => service.requireLocation()).toThrow('Select a project folder');
  expect(() => service.requireLocation(root)).toThrow(
    'Select a project folder',
  );
  expect(() => service.requireLocation(join(root, 'q'), 'p')).toThrow();
});
it('binds nested deliverable folders to their owning project and is idempotent', () => {
  const cwd = join(root, 'p', 'livrables', 'report');
  mkdirSync(cwd, { recursive: true });
  service.bind('agent', cwd, 'p');
  service.bind('agent', cwd, 'p');
  expect(database.db.select().from(projectAgentThreads).all()).toMatchObject([
    { threadId: 'agent', projectId: 'p', workspacePath: join(root, 'p') },
  ]);
  expect(folders.get('agent', 'agent')).toMatchObject({
    projectId: 'p',
    relativePath: 'livrables/report',
    effectivePath: cwd,
  });
});
it('cannot reassign an existing conversation to another project', () => {
  service.bind('agent', join(root, 'p'), 'p');
  expect(() => service.bind('agent', join(root, 'q'), 'q')).toThrow(
    'cannot be moved',
  );
  expect(service.requireSource('agent').projectId).toBe('p');
});
it('rolls back membership when active-folder registration fails', () => {
  vi.spyOn(folders, 'set').mockImplementation(() => {
    throw Error('folder failure');
  });
  expect(() => service.bind('agent', join(root, 'p'), 'p')).toThrow(
    'folder failure',
  );
  expect(service.listMembers()).toEqual([]);
});
it('inherits project and active folder atomically with fork provenance', () => {
  service.bind('source', join(root, 'p'), 'p');
  expect(() =>
    service.withInherited('source', 'child', () => {
      throw Error('edge failed');
    }),
  ).toThrow('edge failed');
  expect(service.listMembers().map((m) => m.id)).toEqual(['source']);
  expect(folders.get('agent', 'child')).toBeNull();
  service.withInherited('source', 'child', () => undefined);
  expect(service.requireSource('child').projectId).toBe('p');
  expect(folders.get('agent', 'child')).toMatchObject({
    projectId: 'p',
    resourceId: 'p',
  });
});
it('refuses a branch with no project-bound source', () => {
  expect(() => service.inherit('missing', 'child')).toThrow(
    'Attach the source agent',
  );
  expect(service.listMembers()).toEqual([]);
});
it('restores a missing membership from a durable folder reference after restart', () => {
  database.db
    .insert(projectActiveFolders)
    .values({
      contextType: 'agent',
      contextId: 'lost',
      projectId: 'p',
      resourceId: 'p',
      relativePath: '',
      createdAt: 1,
      updatedAt: 2,
    })
    .run();
  service.onModuleInit();
  service.onModuleInit();
  expect(service.requireSource('lost')).toMatchObject({
    projectId: 'p',
    workspacePath: join(root, 'p'),
    createdAt: 1,
  });
});
it('does not infer membership from a detached or foreign resource', () => {
  database.db
    .insert(projectActiveFolders)
    .values({
      contextType: 'agent',
      contextId: 'lost',
      projectId: 'p',
      resourceId: 'q',
      relativePath: '',
      createdAt: 1,
      updatedAt: 2,
    })
    .run();
  service.onModuleInit();
  expect(service.listMembers()).toEqual([]);
});
it('recovers project-bound native agents discovered after an interrupted creation', () => {
  service.observe({ id: 'native', cwd: join(root, 'p'), ephemeral: false });
  expect(service.requireSource('native').projectId).toBe('p');
  service.observe({
    id: 'child',
    cwd: '/different-runtime-path',
    ephemeral: false,
    parentThreadId: 'native',
  });
  service.observe({
    id: 'fork',
    cwd: join(root, 'q'),
    ephemeral: false,
    forkedFromId: 'native',
  });
  expect(service.requireSource('child').projectId).toBe('p');
  expect(service.requireSource('fork').projectId).toBe('p');
});
it('does not assign internal ephemeral work or unknown external folders to an arbitrary project', () => {
  service.observe({ id: 'temporary', cwd: join(root, 'p'), ephemeral: true });
  service.observe({ id: 'external', cwd: root, ephemeral: false });
  expect(service.listMembers()).toEqual([]);
});
