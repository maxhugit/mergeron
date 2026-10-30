import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  conversationBranchEdges,
  projectActiveFolders,
  projectAgentThreads,
  projectGitCopyOwners,
  projects,
  projectWorkspaceCopies,
  projectWorkspaces,
} from '../database/schema';
import { AgentGitCopyCleanupService } from './agent-git-copy-cleanup.service';
import type { GitMutationGateService } from './git-mutation-gate.service';

let database: TestDatabase;
let root: string;
let checkout: string;
let service: AgentGitCopyCleanupService;
const mutate = vi.fn();

beforeEach(async () => {
  database = createTestDatabase();
  root = await mkdtemp(path.join(tmpdir(), 'agent-copy-cleanup-'));
  checkout = path.join(root, 'sources', '.external', 'remote', 'copy');
  await mkdir(path.join(checkout, '.git'), { recursive: true });
  await writeFile(path.join(checkout, 'uncommitted.txt'), 'local changes');
  database.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'Project',
      workspacePath: root,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  for (const [id, folder] of [
    ['primary', root],
    ['copy', checkout],
  ])
    database.db
      .insert(projectWorkspaces)
      .values({
        id,
        projectId: 'p',
        name: id,
        path: folder,
        primary: id === 'primary',
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
      localWorkspaceId: 'copy',
      name: 'Copy',
      revision: 'abc',
      state: 'ready',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  insertAgent('agent', checkout);
  insertFolder('agent', 'agent');
  database.db
    .insert(projectGitCopyOwners)
    .values({
      copyId: 'copy',
      agentThreadId: 'agent',
      projectId: 'p',
      createdAt: 1,
    })
    .run();
  mutate
    .mockReset()
    .mockImplementation((operation: () => Promise<void>) => operation());
  service = new AgentGitCopyCleanupService(database.db, {
    mutate,
  } as unknown as GitMutationGateService);
});

function insertAgent(threadId: string, workspacePath: string) {
  database.db
    .insert(projectAgentThreads)
    .values({
      threadId,
      projectId: 'p',
      workspacePath,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
}

function insertFolder(contextType: 'agent' | 'task', contextId: string) {
  database.db
    .insert(projectActiveFolders)
    .values({
      projectId: 'p',
      contextType,
      contextId,
      resourceId: 'copy',
      relativePath: '',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
}

afterEach(async () => {
  database.sqlite.close();
  await rm(root, { recursive: true, force: true });
});

it('deletes the checkout and its metadata, including local changes and Git data', async () => {
  await service.cleanup('agent');

  await expect(stat(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(database.db.select().from(projectWorkspaceCopies).all()).toEqual([]);
  expect(database.db.select().from(projectGitCopyOwners).all()).toEqual([]);
  expect(database.db.select().from(projectActiveFolders).all()).toEqual([]);
  expect(database.db.select().from(projectAgentThreads).all()).toEqual([]);
  expect(database.db.select().from(projectWorkspaces).all()).toMatchObject([
    { id: 'primary' },
  ]);
  expect((await stat(root)).isDirectory()).toBe(true);
});

it('finds a reserved copy even after the agent selected a different workspace', async () => {
  database.db.update(projectAgentThreads).set({ workspacePath: root }).run();
  database.db.delete(projectActiveFolders).run();

  await service.cleanup('agent');

  await expect(stat(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('finds legacy copies without an ownership reservation', async () => {
  database.db.delete(projectGitCopyOwners).run();
  await service.cleanup('agent');
  await expect(stat(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cleans metadata when the checkout is already absent', async () => {
  await rm(checkout, { recursive: true });
  await service.cleanup('agent');
  expect(database.db.select().from(projectWorkspaceCopies).all()).toEqual([]);
});

it('preserves the shared copy when deleting a message version', async () => {
  database.db
    .insert(conversationBranchEdges)
    .values({
      childThreadId: 'version',
      parentThreadId: 'agent',
      treeRootThreadId: 'agent',
      forkBeforeTurnId: 'turn',
      commonPrefixTurnId: 'prefix',
      inheritedTurnIds: '[]',
      source: 'local',
      createdAt: 1,
    })
    .run();
  insertAgent('version', checkout);

  await service.cleanup('version');

  expect((await stat(checkout)).isDirectory()).toBe(true);
  expect(database.db.select().from(projectAgentThreads).all()).toMatchObject([
    { threadId: 'agent' },
  ]);
  expect(mutate).not.toHaveBeenCalled();
  await service.cleanup('agent');
  await expect(stat(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves a copy used by another context and retains ownership for retry', async () => {
  insertFolder('task', 'task');

  await expect(service.cleanup('agent')).rejects.toThrow('GIT_COPY_IN_USE');
  expect((await stat(checkout)).isDirectory()).toBe(true);
  expect(database.db.select().from(projectGitCopyOwners).all()).toHaveLength(1);
});

it('rejects unsafe paths without deleting an attached workspace', async () => {
  const unrelated = path.join(root, 'documents');
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, 'keep.txt'), 'keep');
  database.db
    .update(projectWorkspaces)
    .set({ path: unrelated })
    .where(eq(projectWorkspaces.id, 'copy'))
    .run();
  await expect(service.cleanup('agent')).rejects.toThrow(
    'GIT_COPY_PATH_UNSAFE',
  );
  expect((await stat(root)).isDirectory()).toBe(true);
  expect(await readFile(path.join(unrelated, 'keep.txt'), 'utf8')).toBe('keep');
});

it('rejects symlinks without touching their contents', async () => {
  const elsewhere = path.join(root, 'elsewhere');
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, 'keep.txt'), 'keep');
  await rm(checkout, { recursive: true });
  await symlink(elsewhere, checkout);

  await expect(service.cleanup('agent')).rejects.toThrow(
    'GIT_COPY_PATH_UNSAFE',
  );
  expect(await readFile(path.join(elsewhere, 'keep.txt'), 'utf8')).toBe('keep');
});

it('preserves metadata and files when other agents prevent a Git mutation', async () => {
  mutate.mockRejectedValue(new Error('GIT_BUSY'));
  await expect(service.cleanup('agent')).rejects.toThrow('GIT_BUSY');
  expect((await stat(checkout)).isDirectory()).toBe(true);
  expect(database.db.select().from(projectGitCopyOwners).all()).toHaveLength(1);
});

it('allows deleting an agent without a Git copy', async () => {
  insertAgent('other', root);
  await service.cleanup('other');
  expect((await stat(checkout)).isDirectory()).toBe(true);
  expect(mutate).not.toHaveBeenCalled();
});
