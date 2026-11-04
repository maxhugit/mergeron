import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IdentityService } from '../auth/identity.service';
import { ProjectsService } from './projects.service';
import { ProjectWorkspaceLayout } from './project-workspace-layout';
import { projectSystemAlias } from './project-system-paths';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projects,
  projectWorkspaces,
  projectAgentThreads,
  documentAccessSessions,
  projectActiveFolders,
  projectWorkspaceCopies,
} from '../database/schema';
import { migrateManagedProject } from './managed-project-layout';
import { projectSystemPath, projectDraftPath } from './workspace-structure';

describe('managed project layout v4', () => {
  let database: TestDatabase, parent: string, root: string;
  beforeEach(async () => {
    database = createTestDatabase();
    parent = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-layout-'));
    root = path.join(parent, 'p');
    await fs.mkdir(path.join(root, 'documents'), { recursive: true });
    await fs.mkdir(path.join(root, 'livrables', 'd'), { recursive: true });
    await fs.mkdir(path.join(root, 'sources', '.external', 'git', 'copy'), {
      recursive: true,
    });
    await fs.mkdir(path.join(projectSystemPath(root, 3), 'history'), {
      recursive: true,
    });
    await fs.mkdir(path.join(projectSystemPath(root, 3), 'knowledge'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectSystemPath(root, 3), 'project.json'),
      JSON.stringify({ projectId: 'p', layoutVersion: 3 }),
    );
    await fs.writeFile(path.join(root, 'documents', 'note.txt'), 'keep note');
    await fs.writeFile(
      path.join(root, 'livrables', 'd', 'doc.txt'),
      'keep document',
    );
    await fs.writeFile(
      path.join(root, 'sources', '.external', 'git', 'copy', 'file.txt'),
      'uncommitted change',
    );
    await fs.writeFile(
      path.join(projectSystemPath(root, 3), 'history', 'v1.txt'),
      'immutable version',
    );
    await fs.mkdir(projectDraftPath(root, 3), { recursive: true });
    await fs.writeFile(
      path.join(projectDraftPath(root, 3), 'draft.txt'),
      'unfinished draft',
    );
    const now = Date.now();
    database.db
      .insert(projects)
      .values({
        id: 'p',
        name: 'P',
        workspacePath: root,
        workspaceLayoutVersion: 3,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectWorkspaces)
      .values({
        id: 'primary',
        projectId: 'p',
        name: 'Primary',
        path: root,
        primary: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'agent',
        projectId: 'p',
        workspacePath: path.join(root, 'documents'),
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    database.sqlite.close();
    await fs.rm(parent, { recursive: true, force: true });
  });
  it('preserves documents, dirty source files, versions and drafts and rewrites reference paths', async () => {
    await migrateManagedProject(database.db, 'p', root);
    expect(
      await fs.readFile(path.join(root, 'dossiers', 'note.txt'), 'utf8'),
    ).toBe('keep note');
    expect(
      await fs.readFile(
        path.join(projectSystemPath(root), 'livrables', 'd', 'doc.txt'),
        'utf8',
      ),
    ).toBe('keep document');
    expect(
      await fs.readFile(
        path.join(
          projectSystemPath(root),
          'sources',
          'git',
          'copies',
          'copy',
          'file.txt',
        ),
        'utf8',
      ),
    ).toBe('uncommitted change');
    expect(
      await fs.readFile(
        path.join(projectSystemPath(root), 'history', 'v1.txt'),
        'utf8',
      ),
    ).toBe('immutable version');
    expect(
      await fs.readFile(path.join(projectDraftPath(root), 'draft.txt'), 'utf8'),
    ).toBe('unfinished draft');
    expect(
      database.db.select().from(projectAgentThreads).get()?.workspacePath,
    ).toBe(path.join(root, 'dossiers'));
    expect(
      database.db.select().from(projects).get()?.workspaceLayoutVersion,
    ).toBe(4);
    expect(
      await fs.readdir(path.join(root, 'dossiers', 'sources-importees')),
    ).not.toContain('.external');
  });
  it('can replay a completed journal without duplicating or replacing content', async () => {
    await migrateManagedProject(database.db, 'p', root);
    await migrateManagedProject(database.db, 'p', root);
    expect(
      await fs.readFile(path.join(root, 'dossiers', 'note.txt'), 'utf8'),
    ).toBe('keep note');
  });
  it('refuses destination collisions before moving data', async () => {
    await fs.mkdir(path.join(root, 'dossiers'));
    await expect(migrateManagedProject(database.db, 'p', root)).rejects.toThrow(
      'destination',
    );
    expect(
      await fs.readFile(path.join(root, 'documents', 'note.txt'), 'utf8'),
    ).toBe('keep note');
    expect(
      await fs.readFile(
        path.join(projectSystemPath(root, 3), 'history', 'v1.txt'),
        'utf8',
      ),
    ).toBe('immutable version');
  });
  it('refuses symlinked managed source roots without touching the target', async () => {
    await fs.rm(path.join(root, 'livrables'), { recursive: true });
    await fs.symlink(parent, path.join(root, 'livrables'));
    await expect(migrateManagedProject(database.db, 'p', root)).rejects.toThrow(
      'symbolic',
    );
    expect(
      await fs.readFile(path.join(root, 'documents', 'note.txt'), 'utf8'),
    ).toBe('keep note');
  });
  it('preserves agent references and old document/source links through the public migration entry point', async () => {
    database.db
      .insert(projectActiveFolders)
      .values({
        contextType: 'agent',
        contextId: 'agent',
        projectId: 'p',
        resourceId: 'primary',
        relativePath: 'documents',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    await new ProjectWorkspaceLayout(database.db, parent).migrate();
    expect(
      database.db.select().from(projectActiveFolders).get()?.relativePath,
    ).toBe('dossiers');
    expect(
      projectSystemAlias(
        database.db,
        path.join(root, 'livrables', 'd', 'doc.txt'),
      ),
    ).toBe(path.join(root, '.mergeron-system', 'livrables', 'd', 'doc.txt'));
    expect(
      projectSystemAlias(
        database.db,
        path.join(root, 'sources', '.external', 'git', 'copy', 'file.txt'),
      ),
    ).toBe(
      path.join(
        root,
        '.mergeron-system',
        'sources',
        'git',
        'copies',
        'copy',
        'file.txt',
      ),
    );
  });
  it('replays filesystem relocation after an interrupted database transaction', async () => {
    vi.spyOn(database.db, 'transaction').mockImplementationOnce(() => {
      throw new Error('interrupted');
    });
    await expect(
      new ProjectWorkspaceLayout(database.db, parent).migrate(),
    ).rejects.toThrow('interrupted');
    expect(
      database.db.select().from(projects).get()?.workspaceLayoutVersion,
    ).toBe(3);
    await new ProjectWorkspaceLayout(database.db, parent).migrate();
    expect(
      database.db.select().from(projects).get()?.workspaceLayoutVersion,
    ).toBe(4);
    expect(
      await fs.readFile(path.join(root, 'dossiers', 'note.txt'), 'utf8'),
    ).toBe('keep note');
  });
  it('retains Git HEAD, staged, unstaged and untracked changes without running checkout or reset', async () => {
    const run = promisify(execFile);
    const copy = path.join(root, 'sources', '.external', 'git', 'copy');
    await run('git', ['-C', copy, 'init', '--initial-branch=test']);
    await run('git', ['-C', copy, 'add', 'file.txt']);
    await run('git', [
      '-C',
      copy,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-m',
      'initial',
    ]);
    await fs.writeFile(path.join(copy, 'file.txt'), 'staged');
    await run('git', ['-C', copy, 'add', 'file.txt']);
    await fs.writeFile(path.join(copy, 'file.txt'), 'unstaged');
    await fs.writeFile(path.join(copy, 'untracked.txt'), 'untracked');
    const status = (await run('git', ['-C', copy, 'status', '--porcelain=v1']))
      .stdout;
    const head = (await run('git', ['-C', copy, 'rev-parse', 'HEAD'])).stdout;
    await migrateManagedProject(database.db, 'p', root);
    const moved = path.join(
      root,
      '.mergeron-system',
      'sources',
      'git',
      'copies',
      'copy',
    );
    expect(
      (await run('git', ['-C', moved, 'status', '--porcelain=v1'])).stdout,
    ).toBe(status);
    expect((await run('git', ['-C', moved, 'rev-parse', 'HEAD'])).stdout).toBe(
      head,
    );
  });
  it('blocks linked worktrees before moving any source or document', async () => {
    await fs.writeFile(
      path.join(root, 'sources', '.external', 'git', 'copy', '.git'),
      'gitdir: /elsewhere',
    );
    await expect(migrateManagedProject(database.db, 'p', root)).rejects.toThrow(
      'worktree',
    );
    expect(
      await fs.readFile(path.join(root, 'documents', 'note.txt'), 'utf8'),
    ).toBe('keep note');
  });
  it('keeps a signed document capability usable at its old URL after migration, without widening it', async () => {
    const old = path.join(root, 'livrables', 'd', 'doc.txt');
    database.db
      .insert(documentAccessSessions)
      .values({
        id: 'capability',
        path: old,
        projectId: 'p',
        personId: null,
        administrator: true,
        writable: true,
        expiresAt: Date.now() + 60000,
      })
      .run();
    await migrateManagedProject(database.db, 'p', root);
    const identities = new IdentityService(database.db);
    expect(identities.verifyDocumentSession('capability', old, true)).toBe(
      true,
    );
    expect(
      identities.verifyDocumentSession(
        'capability',
        path.join(root, '.mergeron-system', 'history', 'v1.txt'),
        true,
      ),
    ).toBe(false);
  });
  it('serializes simultaneous startup migration requests against the same database', async () => {
    await Promise.all([
      new ProjectWorkspaceLayout(database.db, parent).migrate(),
      new ProjectWorkspaceLayout(database.db, parent).migrate(),
    ]);
    expect(
      database.db.select().from(projects).get()?.workspaceLayoutVersion,
    ).toBe(4);
    expect(
      await fs.readFile(path.join(root, 'dossiers', 'note.txt'), 'utf8'),
    ).toBe('keep note');
  });
  it('preserves embedded documents, Git changes, history and drafts when deleting a project while keeping its folder', async () => {
    await migrateManagedProject(database.db, 'p', root);
    database.db.delete(projectAgentThreads).run();
    const service = new ProjectsService(
      {} as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      database.db,
    );
    const result = await service.remove('p', 'P');
    expect(result.deletedSystemWorkspaces).toEqual([]);
    expect(database.db.select().from(projects).all()).toHaveLength(0);
    expect(
      await fs.readFile(
        path.join(projectSystemPath(root), 'livrables', 'd', 'doc.txt'),
        'utf8',
      ),
    ).toBe('keep document');
    expect(
      await fs.readFile(
        path.join(
          projectSystemPath(root),
          'sources',
          'git',
          'copies',
          'copy',
          'file.txt',
        ),
        'utf8',
      ),
    ).toBe('uncommitted change');
    expect(
      await fs.readFile(
        path.join(projectSystemPath(root), 'history', 'v1.txt'),
        'utf8',
      ),
    ).toBe('immutable version');
    expect(
      await fs.readFile(path.join(projectDraftPath(root), 'draft.txt'), 'utf8'),
    ).toBe('unfinished draft');
  });
  it('quarantines only an explicitly selected managed copy when the project folder is retained', async () => {
    await migrateManagedProject(database.db, 'p', root);
    const copy = path.join(
      projectSystemPath(root),
      'sources',
      'git',
      'copies',
      'copy',
    );
    database.db
      .insert(projectWorkspaces)
      .values({
        id: 'copy-workspace',
        projectId: 'p',
        name: 'Copy',
        path: copy,
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
        sourceResourceId: 'git',
        localWorkspaceId: 'copy-workspace',
        name: 'Copy',
        revision: 'head',
        state: 'ready',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db.delete(projectAgentThreads).run();
    const service = new ProjectsService(
      {} as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      database.db,
    );
    const result = await service.remove('p', 'P', ['copy-workspace']);
    expect(result.deletedWorkspaces).toEqual([copy]);
    await expect(fs.stat(copy)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await fs.readFile(
        path.join(projectSystemPath(root), 'livrables', 'd', 'doc.txt'),
        'utf8',
      ),
    ).toBe('keep document');
  });
});
