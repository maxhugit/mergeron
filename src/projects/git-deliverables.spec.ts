import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import * as schema from '../database/schema';
import { FilesService } from '../files/files.service';
import { IdentityService } from '../auth/identity.service';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { DocumentOrganizationService } from '../deliverables/document-organization.service';
import { GitDeliverablesService } from './git-deliverables.service';
import { WorkspaceGitService } from './workspace-git.service';
import type { WorkspaceCopiesService } from './workspace-copies.service';
import type { WorkspaceResourcesService } from './workspace-resources.service';
import type { GitMutationGateService } from '../threads/git-mutation-gate.service';
import type { SettingsService } from '../settings/settings.service';
import { SECURITY_SETTING_KEYS } from '../settings/settings.definitions';
import { accessContext } from '../auth/access-context';
import { Logger } from '@nestjs/common';
import { digest } from '../deliverables/git-deliverables-format';

describe('optional Git deliverables with real retained versions and a real repository', () => {
  let database: TestDatabase,
    root: string,
    repo: string,
    deliverables: DeliverablesService,
    organization: DocumentOrganizationService,
    service: GitDeliverablesService;
  let copyViews: ReturnType<WorkspaceCopiesService['list']>;
  const scopedMutation = vi.fn((thread: string, fn: () => Promise<unknown>) =>
    fn(),
  );
  const asAgent = <T>(thread: string, fn: () => T) =>
    accessContext.run(
      {
        localAgentThreadId: thread,
        identity: { role: 'administrator' } as never,
        identities: {
          requireProject: () => {},
          requireAdministrator: () => {},
        } as unknown as IdentityService,
      },
      fn,
    );
  const options = {
    boardId: 'board',
    copyId: 'copy',
    directory: 'livrables',
    restrictedIds: [] as string[],
  };
  beforeEach(async () => {
    database = createTestDatabase();
    root = await fs.realpath(
      await fs.mkdtemp(path.join(tmpdir(), 'git-deliverables-')),
    );
    repo = path.join(root, 'repository');
    await fs.mkdir(repo);
    await fs.mkdir(path.join(root, '.mergeron-system'));
    await fs.mkdir(path.join(root, '.mergeron'));
    execFileSync('git', ['init', '--quiet', repo]);
    database.db
      .insert(schema.projects)
      .values({
        id: 'p',
        name: 'Project',
        workspacePath: root,
        workspaceLayoutVersion: 4,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(schema.projectWorkspaces)
      .values({
        id: 'w',
        projectId: 'p',
        name: 'Main',
        path: root,
        primary: true,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(schema.projectResources)
      .values({
        id: 'board',
        projectId: 'p',
        name: 'Deliverables',
        type: 'deliverable_board',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const settings = {
      getStringSetting: (key: string) =>
        key === SECURITY_SETTING_KEYS.workspaceRoots ? root : '',
      getSetting: () => ({ value: '' }),
      onChange: () => () => {},
    } as unknown as SettingsService;
    const files = new FilesService(settings, database.db);
    const identities = new IdentityService(database.db);
    deliverables = new DeliverablesService(
      database.db,
      files,
      identities,
      new ActiveFoldersService(database.db),
    );
    organization = new DocumentOrganizationService(
      database.db,
      deliverables,
      identities,
    );
    copyViews = [
      {
        id: 'copy',
        projectId: 'p',
        name: 'Agent Git',
        state: 'ready',
        sourceEnabled: true,
        sourceType: 'git',
        localPath: repo,
        accessMode: 'read_write',
        ownerThreadIds: ['agent'],
      },
    ] as ReturnType<WorkspaceCopiesService['list']>;
    const copies = {
      list: () => copyViews,
    } as unknown as WorkspaceCopiesService;
    scopedMutation.mockClear();
    const git = new WorkspaceGitService(
      copies,
      {} as WorkspaceResourcesService,
    );
    const gate = {
      mutate: (fn: () => Promise<unknown>) => fn(),
      mutateDeferredFromAgent: scopedMutation,
    } as unknown as GitMutationGateService;
    service = new GitDeliverablesService(
      database.db,
      deliverables,
      organization,
      git,
      copies,
      gate,
    );
  });
  afterEach(async () => {
    service.onModuleDestroy();
    organization.onModuleDestroy();
    database.sqlite.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function upload(id: string, text: string, documentId?: string) {
    const current = documentId
      ? deliverables
          .documents('p', 'board', id)
          .find((d) => d.id === documentId)
      : undefined;
    async function* data() {
      await Promise.resolve();
      yield {
        filename: current?.name ?? 'notes.md',
        stream: Readable.from(text),
      };
    }
    await deliverables.uploadDocuments('p', 'board', id, data(), {
      documentId,
      expectedVersion: current?.currentVersionNumber,
    });
    return deliverables.documents('p', 'board', id)[0];
  }
  async function sync() {
    const preview = await service.preview('p', options);
    await service.apply('p', { options, fingerprint: preview.fingerprint });
    return preview;
  }
  async function external(labels: string[] = []) {
    const folder = path.join(repo, 'livrables', 'cadrage');
    await fs.mkdir(folder, { recursive: true });
    const manifest = {
      format: 'mergeron-deliverable',
      version: 1,
      id: 'portable',
      title: 'Cadrage',
      description: 'Portable description',
      labels,
      documents: [{ id: 'text', path: 'notes.md', labels }],
    };
    await fs.writeFile(
      path.join(folder, 'livrable.json'),
      JSON.stringify(manifest),
    );
    await fs.writeFile(path.join(folder, 'notes.md'), 'first');
    return { folder, manifest };
  }
  it('is disabled by default, previews without writes and exports only retained content without committing', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Cadrage' });
    const doc = await upload(item.id, '# retained');
    expect((await service.status('p')).boards[0].settings).toBeNull();
    const preview = await service.preview('p', options);
    expect(preview.changes).toContainEqual(
      expect.objectContaining({ action: 'export' }),
    );
    await expect(fs.stat(path.join(repo, 'livrables'))).rejects.toThrow();
    await service.apply('p', { options, fingerprint: preview.fingerprint });
    const folder = path.join(repo, 'livrables', item.id);
    expect(await fs.readFile(path.join(folder, 'notes.md'), 'utf8')).toBe(
      '# retained',
    );
    const raw = await fs.readFile(path.join(folder, 'livrable.json'), 'utf8');
    expect(raw).not.toContain(root);
    expect(
      (JSON.parse(raw) as { documents: { id: string }[] }).documents[0].id,
    ).toBe(doc.id);
    expect(
      execFileSync('git', [
        '-C',
        repo,
        'diff',
        '--cached',
        '--name-only',
      ]).toString(),
    ).toBe('');
    expect((await service.preview('p', options)).changes).toEqual([]);
  });
  it('recognizes on opening without importing, preserves labels, imports new versions and is idempotent', async () => {
    const remote = await external(['Réunion']);
    expect((await service.status('p', 'copy')).discovered[0].title).toBe(
      'Cadrage',
    );
    expect(deliverables.board('p', 'board').deliverables).toHaveLength(0);
    await sync();
    const item = deliverables.board('p', 'board').deliverables[0];
    const doc = deliverables.documents('p', 'board', item.id)[0];
    expect(doc.currentVersionNumber).toBe(1);
    const labels = organization.read('p', 'board', item.id);
    expect(labels.labels[0].name).toBe('Réunion');
    expect(labels.assignments[doc.id]).toEqual([labels.labels[0].id]);
    await fs.writeFile(path.join(remote.folder, 'notes.md'), 'second');
    await sync();
    await sync();
    expect(
      deliverables.documents('p', 'board', item.id)[0].currentVersionNumber,
    ).toBe(2);
    expect(await fs.readFile(doc.sourcePath, 'utf8')).toBe('second');
  });
  it('refuses both-sided content conflicts and stale plans before writing', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Document' });
    const doc = await upload(item.id, 'base');
    await sync();
    const plan = await service.preview('p', options);
    await fs.writeFile(
      path.join(repo, 'livrables', item.id, 'notes.md'),
      'remote',
    );
    await expect(
      service.apply('p', { options, fingerprint: plan.fingerprint }),
    ).rejects.toThrow('GIT_DELIVERABLES_CHANGED');
    await upload(item.id, 'local', doc.id);
    const conflict = await service.preview('p', options);
    expect(conflict.canApply).toBe(false);
    await expect(
      service.apply('p', { options, fingerprint: conflict.fingerprint }),
    ).rejects.toThrow('GIT_DELIVERABLES_CONFLICTS');
    expect(await fs.readFile(doc.sourcePath, 'utf8')).toBe('local');
    expect(
      await fs.readFile(
        path.join(repo, 'livrables', item.id, 'notes.md'),
        'utf8',
      ),
    ).toBe('remote');
  });
  it('never deletes on Git removal and never imports into a finalized deliverable', async () => {
    const { folder } = await external();
    await sync();
    const item = deliverables.board('p', 'board').deliverables[0];
    database.db
      .update(schema.projectDeliverables)
      .set({ lifecycleStatus: 'finalized' })
      .where(eq(schema.projectDeliverables.id, item.id))
      .run();
    await fs.writeFile(path.join(folder, 'notes.md'), 'changed');
    expect((await service.preview('p', options)).changes).toContainEqual(
      expect.objectContaining({ reason: 'read_only_deliverable' }),
    );
    await fs.rm(path.join(folder, 'livrable.json'));
    expect((await service.preview('p', options)).changes).toContainEqual(
      expect.objectContaining({ reason: 'removed_in_git' }),
    );
    expect(deliverables.documents('p', 'board', item.id)).toHaveLength(1);
  });
  it('keeps restricted deliverables out unless explicitly selected and disabling preserves Git files', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Private' });
    await upload(item.id, 'secret');
    database.db
      .update(schema.projectDeliverables)
      .set({ confidentiality: 'restricted' })
      .where(eq(schema.projectDeliverables.id, item.id))
      .run();
    const preview = await service.preview('p', options);
    expect(preview.changes[0].action).toBe('excluded');
    await service.apply('p', { options, fingerprint: preview.fingerprint });
    await expect(
      fs.stat(path.join(repo, 'livrables', item.id)),
    ).rejects.toThrow();
    const opted = { ...options, restrictedIds: [item.id] };
    const plan = await service.preview('p', opted);
    await service.apply('p', { options: opted, fingerprint: plan.fingerprint });
    service.disable('p', 'board');
    expect(
      await fs.readFile(
        path.join(repo, 'livrables', item.id, 'notes.md'),
        'utf8',
      ),
    ).toBe('secret');
  });
  it('retains document identity across a Git rename', async () => {
    const { folder, manifest } = await external();
    await sync();
    const item = deliverables.board('p', 'board').deliverables[0];
    const doc = deliverables.documents('p', 'board', item.id)[0];
    await fs.rename(
      path.join(folder, 'notes.md'),
      path.join(folder, 'renamed.md'),
    );
    manifest.documents[0].path = 'renamed.md';
    await fs.writeFile(
      path.join(folder, 'livrable.json'),
      JSON.stringify(manifest),
    );
    await sync();
    const renamed = deliverables.documents('p', 'board', item.id)[0];
    expect(renamed.id).toBe(doc.id);
    expect(renamed.name).toBe('renamed.md');
  });
  it('blocks symlinked sources and malformed paths, and does not execute repository metadata', async () => {
    const { folder, manifest } = await external();
    await fs.rm(path.join(folder, 'notes.md'));
    await fs.symlink(path.join(root, 'outside'), path.join(folder, 'notes.md'));
    await expect(service.preview('p', options)).rejects.toThrow(
      'GIT_DELIVERABLES_UNSAFE_PATH',
    );
    manifest.documents[0].path = '../outside';
    await fs.writeFile(
      path.join(folder, 'livrable.json'),
      JSON.stringify(manifest),
    );
    await expect(service.preview('p', options)).rejects.toThrow(
      'GIT_DELIVERABLES_INVALID_MANIFEST',
    );
    await expect(
      service.preview('p', { ...options, directory: '../secrets' }),
    ).rejects.toThrow();
    expect(deliverables.board('p', 'board').deliverables).toHaveLength(0);
  });
  it('can explicitly convert plain folders and does not overwrite unrecognized files', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Existing' });
    await upload(item.id, 'retained');
    const collision = path.join(repo, 'livrables', item.id);
    await fs.mkdir(collision, { recursive: true });
    await fs.writeFile(path.join(collision, 'notes.md'), 'unrelated');
    expect((await service.preview('p', options)).changes).toContainEqual(
      expect.objectContaining({ reason: 'untracked_file_collision' }),
    );
    await fs.rm(collision, { recursive: true });
    const folder = path.join(repo, 'livrables', 'plain');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'plain.md'), 'from git');
    const adopted = { ...options, adoptFolders: true };
    const plan = await service.preview('p', adopted);
    await service.apply('p', {
      options: adopted,
      fingerprint: plan.fingerprint,
    });
    expect(
      (
        JSON.parse(
          await fs.readFile(path.join(folder, 'livrable.json'), 'utf8'),
        ) as { format: string }
      ).format,
    ).toBe('mergeron-deliverable');
    expect(deliverables.board('p', 'board').deliverables).toHaveLength(2);
  });
  it('does not confuse an LFS pointer with document content or bypass execution permissions', async () => {
    const { folder } = await external();
    await fs.writeFile(
      path.join(folder, 'notes.md'),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${digest('audio')}\nsize 100\n`,
    );
    expect((await service.preview('p', options)).changes).toContainEqual(
      expect.objectContaining({ reason: 'lfs_content_missing' }),
    );
    const identities = {
      requireAdministrator: () => {
        throw new Error('forbidden');
      },
    } as unknown as IdentityService;
    await expect(
      accessContext.run(
        { identity: { role: 'standard' } as never, identities },
        () => service.preview('p', options),
      ),
    ).rejects.toThrow('forbidden');
  });
  it('resumes a partially failed import without duplicating its deliverable or completed versions', async () => {
    const { folder, manifest } = await external();
    manifest.documents.push({ id: 'second', path: 'second.md', labels: [] });
    await fs.writeFile(path.join(folder, 'second.md'), 'other');
    await fs.writeFile(
      path.join(folder, 'livrable.json'),
      JSON.stringify(manifest),
    );
    const original = deliverables.uploadDocuments.bind(
      deliverables,
    ) as DeliverablesService['uploadDocuments'];
    let calls = 0;
    const failure = vi
      .spyOn(deliverables, 'uploadDocuments')
      .mockImplementation((...args) => {
        if (++calls === 2)
          return Promise.reject(new Error('synthetic interruption'));
        return original(...args);
      });
    await expect(sync()).rejects.toThrow('synthetic interruption');
    expect((await service.status('p')).boards[0].settings?.lastError).toBe(
      'GIT_DELIVERABLES_SYNC_FAILED',
    );
    failure.mockRestore();
    await sync();
    await sync();
    const items = deliverables.board('p', 'board').deliverables;
    expect(items).toHaveLength(1);
    expect(
      deliverables
        .documents('p', 'board', items[0].id)
        .map((d) => d.currentVersionNumber),
    ).toEqual([1, 1]);
  });
  it('recognizes a custom directory on a new installation through the portable root index', async () => {
    const { folder } = await external();
    await fs.mkdir(path.join(repo, 'documents'));
    await fs.rename(
      path.join(repo, 'livrables'),
      path.join(repo, 'documents', 'retained'),
    );
    await fs.writeFile(
      path.join(repo, '.mergeron-deliverables.json'),
      JSON.stringify({
        format: 'mergeron-deliverables-index',
        version: 1,
        directory: 'documents/retained',
      }),
    );
    const status = await service.status('p', 'copy');
    expect(status.discovered).toHaveLength(1);
    expect(status.copies[0].directory).toBe('documents/retained');
    const custom = { ...options, directory: 'documents/retained' };
    const plan = await service.preview('p', custom);
    await service.apply('p', {
      options: custom,
      fingerprint: plan.fingerprint,
    });
    expect(
      await fs.readFile(
        path.join(
          repo,
          'documents',
          'retained',
          path.basename(folder),
          'notes.md',
        ),
        'utf8',
      ),
    ).toBe('first');
  });
  it('does not fail a domain save when an internal board is ineligible for Git', async () => {
    database.db
      .update(schema.projectResources)
      .set({ config: { internal: true } })
      .where(eq(schema.projectResources.id, 'board'))
      .run();
    service.onModuleInit();
    const warning = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      await expect(
        deliverables.create('p', 'board', { title: 'Internal document' }),
      ).resolves.toHaveProperty('id');
    } finally {
      warning.mockRestore();
    }
  });
  it('settles a queued export safely when its board is deleted', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'Removed board',
    });
    const doc = await upload(item.id, 'retained');
    await sync();
    service.onModuleInit();
    const warning = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      await upload(item.id, 'pending export', doc.id);
      database.db
        .delete(schema.projectResources)
        .where(eq(schema.projectResources.id, 'board'))
        .run();
      await vi.waitFor(() => expect(warning).toHaveBeenCalled(), {
        timeout: 3000,
      });
    } finally {
      warning.mockRestore();
    }
  });
  it('exports an independently saved version automatically once mode is active', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'Automatic',
    });
    const doc = await upload(item.id, 'initial');
    await sync();
    service.onModuleInit();
    await upload(item.id, 'new retained version', doc.id);
    await vi.waitFor(
      async () =>
        expect(
          await fs.readFile(
            path.join(repo, 'livrables', item.id, 'notes.md'),
            'utf8',
          ),
        ).toBe('new retained version'),
      { timeout: 4000 },
    );
  });
  it('configures the single project board without choosing a copy or writing repository files', async () => {
    service.configure('p', {
      boardId: 'board',
      enabled: true,
      directory: 'livrables',
      restrictedIds: [],
    });
    const status = await service.status('p');
    expect(status.boards[0].settings).toMatchObject({
      enabled: true,
      mode: 'agent_copies',
    });
    expect(status.boards[0].settings).not.toHaveProperty('copyId');
    await expect(fs.stat(path.join(repo, 'livrables'))).rejects.toThrow();
    copyViews[0].ownerThreadIds = [];
    expect(() =>
      service.configure('p', {
        boardId: 'board',
        enabled: true,
        directory: 'livrables',
      }),
    ).toThrow('GIT_DELIVERABLES_AGENT_COPY_REQUIRED');
    expect(
      service.configure('p', {
        boardId: 'board',
        enabled: false,
        directory: 'livrables',
      }),
    ).toEqual({ enabled: false });
  });
  it('requires an agent-owned copy and refuses a shared, foreign, read-only or unavailable copy', async () => {
    for (const change of [
      { ownerThreadIds: [] },
      { ownerThreadIds: ['someone-else'] },
      { ownerThreadIds: ['agent', 'other'] },
      { accessMode: 'read_only' },
      { state: 'missing' },
      { sourceEnabled: false },
      { sourceType: 'ftp' },
    ]) {
      const original = { ...copyViews[0] };
      Object.assign(copyViews[0], change);
      await expect(
        asAgent('agent', () => service.preview('p', options)),
      ).rejects.toThrow('GIT_DELIVERABLES_AGENT_COPY_REQUIRED');
      Object.assign(copyViews[0], original);
    }
    const item = await deliverables.create('p', 'board', { title: 'Own copy' });
    await upload(item.id, 'retained');
    await asAgent('agent', async () => {
      const { copyId, ...automatic } = options;
      expect(copyId).toBe('copy');
      const plan = await service.preview('p', automatic);
      expect(plan.copyId).toBe('copy');
      await service.apply('p', {
        options: automatic,
        fingerprint: plan.fingerprint,
      });
    });
    expect(scopedMutation).toHaveBeenCalledWith('agent', expect.any(Function), {
      copyPath: repo,
    });
  });
  it('rejects agent modifications before changing versions or metadata if their copy is absent', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'Preserved',
    });
    const doc = await upload(item.id, 'original');
    await sync();
    service.onModuleInit();
    await expect(
      asAgent('missing-agent', () =>
        deliverables.create('p', 'board', { title: 'Must not exist' }),
      ),
    ).rejects.toThrow('GIT_DELIVERABLES_AGENT_COPY_REQUIRED');
    expect(() =>
      asAgent('missing-agent', () =>
        deliverables.update('p', 'board', item.id, {
          title: 'Must not change',
          version: item.version,
        }),
      ),
    ).toThrow('GIT_DELIVERABLES_AGENT_COPY_REQUIRED');
    await expect(
      asAgent('missing-agent', () => upload(item.id, 'must not save', doc.id)),
    ).rejects.toThrow('GIT_DELIVERABLES_AGENT_COPY_REQUIRED');
    expect(() =>
      asAgent('missing-agent', () =>
        organization.createLabel('p', 'board', item.id, {
          name: 'No label',
          expectedRevision: 0,
        }),
      ),
    ).toThrow('GIT_DELIVERABLES_AGENT_COPY_REQUIRED');
    expect(deliverables.board('p', 'board').deliverables).toHaveLength(1);
    expect(deliverables.get('p', 'board', item.id).title).toBe('Preserved');
    expect(
      deliverables.documents('p', 'board', item.id)[0].currentVersionNumber,
    ).toBe(1);
    await fs.rename(repo, repo + '-moved');
    await expect(
      asAgent('agent', () => upload(item.id, 'lost clone', doc.id)),
    ).rejects.toThrow('GIT_DELIVERABLES_AGENT_COPY_REQUIRED');
  });
  it('keeps independent comparison baselines for two agent clones without writing the other copy', async () => {
    const repo2 = path.join(root, 'repository2');
    await fs.mkdir(repo2);
    execFileSync('git', ['init', '--quiet', repo2]);
    copyViews.push({
      ...copyViews[0],
      id: 'copy2',
      localPath: repo2,
      ownerThreadIds: ['agent2'],
    });
    const item = await deliverables.create('p', 'board', {
      title: 'Both agents',
    });
    const doc = await upload(item.id, 'base');
    await sync();
    const second = { ...options, copyId: 'copy2' };
    const plan = await service.preview('p', second);
    await service.apply('p', {
      options: second,
      fingerprint: plan.fingerprint,
    });
    await upload(item.id, 'next', doc.id);
    await sync();
    expect(
      await fs.readFile(
        path.join(repo2, 'livrables', item.id, 'notes.md'),
        'utf8',
      ),
    ).toBe('base');
    const pending = await service.preview('p', second);
    expect(pending.changes).toContainEqual(
      expect.objectContaining({ action: 'export', reason: 'document' }),
    );
    await service.apply('p', {
      options: second,
      fingerprint: pending.fingerprint,
    });
    expect(
      await fs.readFile(
        path.join(repo2, 'livrables', item.id, 'notes.md'),
        'utf8',
      ),
    ).toBe('next');
    expect((await service.preview('p', options)).changes).toEqual([]);
  });
  it('preserves legacy shared bindings and files without exporting to the shared copy', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Legacy' });
    await upload(item.id, 'retained');
    await sync();
    const board = database.db
      .select()
      .from(schema.projectResources)
      .where(eq(schema.projectResources.id, 'board'))
      .get()!;
    const stored = board.config.gitDeliverables as {
      copies: Record<string, { bindings: unknown }>;
      [key: string]: unknown;
    };
    const legacy = {
      ...options,
      enabled: true,
      lastError: null,
      lastSyncAt: 1,
      bindings: stored.copies.copy.bindings,
    };
    database.db
      .update(schema.projectResources)
      .set({ config: { gitDeliverables: legacy } })
      .where(eq(schema.projectResources.id, 'board'))
      .run();
    copyViews[0].ownerThreadIds = [];
    const repo2 = path.join(root, 'agent-repo');
    await fs.mkdir(repo2);
    execFileSync('git', ['init', '--quiet', repo2]);
    copyViews.push({
      ...copyViews[0],
      id: 'copy2',
      localPath: repo2,
      ownerThreadIds: ['agent2'],
    });
    service.configure('p', {
      boardId: 'board',
      enabled: true,
      directory: 'livrables',
    });
    const after = database.db
      .select()
      .from(schema.projectResources)
      .where(eq(schema.projectResources.id, 'board'))
      .get()!;
    expect(after.config.gitDeliverables).toMatchObject({
      copies: { copy: { bindings: legacy.bindings } },
    });
    await expect(service.preview('p', options)).rejects.toThrow(
      'GIT_DELIVERABLES_AGENT_COPY_REQUIRED',
    );
    const second = { ...options, copyId: 'copy2' };
    const plan = await service.preview('p', second);
    await service.apply('p', {
      options: second,
      fingerprint: plan.fingerprint,
    });
    expect(
      await fs.readFile(
        path.join(repo, 'livrables', item.id, 'notes.md'),
        'utf8',
      ),
    ).toBe('retained');
    expect(
      await fs.readFile(
        path.join(repo2, 'livrables', item.id, 'notes.md'),
        'utf8',
      ),
    ).toBe('retained');
  });
  it('refuses a foreign manager and keeps the database single-manager invariant', async () => {
    await expect(service.preview('another-project', options)).rejects.toThrow(
      'GIT_DELIVERABLES_BOARD_UNAVAILABLE',
    );
    expect(() =>
      database.db
        .insert(schema.projectResources)
        .values({
          id: 'duplicate',
          projectId: 'p',
          name: 'Duplicate',
          type: 'deliverable_board',
          createdAt: 1,
          updatedAt: 1,
        })
        .run(),
    ).toThrow();
    expect((await service.status('p')).boards).toHaveLength(1);
  });
  it('does not coalesce two agents into a single agent export queue', async () => {
    const repo2 = path.join(root, 'agent-two');
    await fs.mkdir(repo2);
    execFileSync('git', ['init', '--quiet', repo2]);
    copyViews.push({
      ...copyViews[0],
      id: 'copy2',
      localPath: repo2,
      ownerThreadIds: ['agent2'],
    });
    const item = await deliverables.create('p', 'board', { title: 'Queued' });
    const doc = await upload(item.id, 'base');
    await sync();
    service.onModuleInit();
    const preview = vi.spyOn(service, 'preview').mockResolvedValue({
      fingerprint: 'no-change',
      copyId: 'copy',
      canApply: true,
      changes: [],
    });
    await asAgent('agent', () => upload(item.id, 'one', doc.id));
    await asAgent('agent2', () => upload(item.id, 'two', doc.id));
    await vi.waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    expect(
      preview.mock.calls
        .map(([, input]) => (input as { copyId: string }).copyId)
        .sort(),
    ).toEqual(['copy', 'copy2']);
    preview.mockRestore();
  });
});
