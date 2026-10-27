import { mkdtemp, mkdir, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projects,
  projectWorkspaces,
  projectWorkspaceCopies,
  projectAgentThreads,
  projectActiveFolders,
  projectGitCopyOwners,
  conversationBranchEdges,
} from '../database/schema';
import {
  claimAgentCopy,
  copyAgentIds,
  assertAgentCanOwnCopy,
} from './git-copy-ownership';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { WorkspaceCopiesService } from './workspace-copies.service';
import type { WorkspaceResourcesService } from './workspace-resources.service';
import type { GitMutationGateService } from '../threads/git-mutation-gate.service';

let database: TestDatabase;
let root: string;
beforeEach(async () => {
  database = createTestDatabase();
  root = await mkdtemp(path.join(tmpdir(), 'copy-ownership-'));
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
  for (const id of ['primary', 'a', 'b']) {
    const folder = path.join(root, id);
    await mkdir(folder);
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
    if (id !== 'primary')
      database.db
        .insert(projectWorkspaceCopies)
        .values({
          id,
          projectId: 'p',
          sourceResourceId: 'remote',
          localWorkspaceId: id,
          name: id,
          branch: 'main',
          revision: 'abc',
          state: 'ready',
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
  }
  for (const id of ['agent-1', 'agent-2'])
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: id,
        projectId: 'p',
        workspacePath: path.join(root, 'primary'),
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
});
afterEach(async () => {
  database.sqlite.close();
  await rm(root, { recursive: true, force: true });
});

it('reserves one copy per work agent and one work agent per copy, including subdirectories', async () => {
  await mkdir(path.join(root, 'a/sub'));
  const folders = new ActiveFoldersService(database.db);
  expect(
    folders.reserveAgentCopy('p', 'agent-1', path.join(root, 'a/sub')),
  ).toBe('a');
  expect(copyAgentIds(database.db, 'p', 'a')).toEqual(['agent-1']);
  expect(() =>
    folders.reserveAgentCopy('p', 'agent-2', path.join(root, 'a')),
  ).toThrow('GIT_COPY_OWNED');
  expect(() =>
    folders.reserveAgentCopy('p', 'agent-1', path.join(root, 'b')),
  ).toThrow('GIT_AGENT_COPY_EXISTS');
  expect(() =>
    folders.reserveAgentCopy('p', null, path.join(root, 'b')),
  ).toThrow('GIT_COPY_AGENT_REQUIRED');
  expect(folders.reserveAgentCopy('p', 'agent-2', path.join(root, 'b'))).toBe(
    'b',
  );
  expect(database.db.select().from(projectGitCopyOwners).all()).toHaveLength(2);
});

it('keeps the reservation when the agent selects the primary folder', () => {
  const folders = new ActiveFoldersService(database.db);
  folders.reserveAgentCopy('p', 'agent-1', path.join(root, 'a'));
  folders.reserveAgentCopy('p', 'agent-1', path.join(root, 'primary'));
  expect(() => assertAgentCanOwnCopy(database.db, 'p', 'agent-1')).toThrow(
    'GIT_AGENT_COPY_EXISTS',
  );
  expect(() => claimAgentCopy(database.db, 'p', 'agent-2', 'a')).toThrow(
    'GIT_COPY_OWNED',
  );
});

it('treats edited-message versions as one work agent and not as multiple copy owners', () => {
  database.db
    .insert(projectAgentThreads)
    .values({
      threadId: 'edited-version',
      projectId: 'p',
      workspacePath: path.join(root, 'a'),
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(conversationBranchEdges)
    .values({
      childThreadId: 'edited-version',
      parentThreadId: 'agent-1',
      treeRootThreadId: 'agent-1',
      forkBeforeTurnId: 'turn',
      commonPrefixTurnId: '',
      inheritedTurnIds: '[]',
      createdAt: 1,
    })
    .run();
  claimAgentCopy(database.db, 'p', 'edited-version', 'a');
  expect(copyAgentIds(database.db, 'p', 'a')).toEqual(['agent-1']);
  claimAgentCopy(database.db, 'p', 'agent-1', 'a');
  expect(() => claimAgentCopy(database.db, 'p', 'edited-version', 'b')).toThrow(
    'GIT_AGENT_COPY_EXISTS',
  );
  expect(database.db.select().from(projectGitCopyOwners).all()).toHaveLength(1);
});

it('preserves legacy choices and refuses to arbitrarily assign a shared copy', () => {
  for (const id of ['agent-1', 'agent-2'])
    database.db
      .insert(projectActiveFolders)
      .values({
        projectId: 'p',
        contextType: 'agent',
        contextId: id,
        resourceId: 'a',
        relativePath: '',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  expect(copyAgentIds(database.db, 'p', 'a')).toEqual(['agent-1', 'agent-2']);
  expect(() => claimAgentCopy(database.db, 'p', 'agent-1', 'a')).toThrow(
    'GIT_COPY_OWNED',
  );
  expect(database.db.select().from(projectActiveFolders).all()).toHaveLength(2);
  expect(database.db.select().from(projectGitCopyOwners).all()).toHaveLength(0);
});

it('backfills an existing unambiguous agent selection and preserves it after switching folders', async () => {
  database.db
    .insert(projectActiveFolders)
    .values({
      projectId: 'p',
      contextType: 'agent',
      contextId: 'agent-1',
      resourceId: 'a',
      relativePath: '',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.sqlite.exec('DROP TABLE project_git_copy_owners');
  database.sqlite.exec(
    await readFile(
      path.join(process.cwd(), 'drizzle/0055_agent_git_copy_owners.sql'),
      'utf8',
    ),
  );
  expect(database.db.select().from(projectGitCopyOwners).all()).toMatchObject([
    { copyId: 'a', agentThreadId: 'agent-1' },
  ]);
  expect((await stat(path.join(root, 'a'))).isDirectory()).toBe(true);
});

it('does not choose an owner for an ambiguous shared copy during migration', async () => {
  for (const agentId of ['agent-1', 'agent-2'])
    database.db
      .insert(projectActiveFolders)
      .values({
        projectId: 'p',
        contextType: 'agent',
        contextId: agentId,
        resourceId: 'a',
        relativePath: '',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  database.sqlite.exec('DROP TABLE project_git_copy_owners');
  database.sqlite.exec(
    await readFile(
      path.join(process.cwd(), 'drizzle/0055_agent_git_copy_owners.sql'),
      'utf8',
    ),
  );
  expect(database.db.select().from(projectGitCopyOwners).all()).toHaveLength(0);
  expect(database.db.select().from(projectActiveFolders).all()).toHaveLength(2);
});

it('requires a deliberate release after selecting another folder and never removes the copy', async () => {
  claimAgentCopy(database.db, 'p', 'agent-1', 'a');
  const copies = new WorkspaceCopiesService(
    database.db,
    {} as WorkspaceResourcesService,
    {
      mutate: (operation: () => Promise<unknown>) => operation(),
    } as GitMutationGateService,
  );
  database.db
    .insert(projectActiveFolders)
    .values({
      projectId: 'p',
      contextType: 'agent',
      contextId: 'agent-1',
      resourceId: 'a',
      relativePath: '',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  await expect(
    copies.releaseOwner('p', 'a', {
      agentThreadId: 'agent-1',
      confirmation: 'RELEASE_COPY_OWNER',
    }),
  ).rejects.toThrow('GIT_COPY_IN_USE');
  database.sqlite
    .prepare(
      'UPDATE project_active_folders SET resource_id = ? WHERE context_id = ?',
    )
    .run('primary', 'agent-1');
  await expect(
    copies.releaseOwner('p', 'a', {
      agentThreadId: 'agent-1',
      confirmation: 'RELEASE_COPY_OWNER',
    }),
  ).resolves.toEqual({ released: true });
  expect(database.db.select().from(projectGitCopyOwners).all()).toHaveLength(0);
  expect((await stat(path.join(root, 'a'))).isDirectory()).toBe(true);
  claimAgentCopy(database.db, 'p', 'agent-2', 'a');
});
