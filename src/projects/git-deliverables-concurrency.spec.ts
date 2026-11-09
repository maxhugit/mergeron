import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { AsyncResource } from 'node:async_hooks';
import { eq } from 'drizzle-orm';
import * as gitFormat from '../deliverables/git-deliverables-format';
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
import { Logger } from '@nestjs/common';

describe('Git deliverable concurrency and interrupted transfers', () => {
  let database: TestDatabase,
    root: string,
    repo: string,
    deliverables: DeliverablesService,
    organization: DocumentOrganizationService,
    service: GitDeliverablesService,
    git: WorkspaceGitService;
  let copyViews: ReturnType<WorkspaceCopiesService['list']>;
  const scopedMutation = vi.fn((thread: string, fn: () => Promise<unknown>) =>
    fn(),
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
        ownerAgentIds: ['agent'],
      },
    ] as ReturnType<WorkspaceCopiesService['list']>;
    const copies = {
      list: () => copyViews,
    } as unknown as WorkspaceCopiesService;
    scopedMutation.mockClear();
    git = new WorkspaceGitService(copies, {} as WorkspaceResourcesService);
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
    vi.restoreAllMocks();
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

  it('rejects a concurrent local save instead of changing an accepted import into an export', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'Direction race',
    });
    const doc = await upload(item.id, 'initial');
    await sync();
    const file = path.join(repo, 'livrables', item.id, 'notes.md');
    await fs.writeFile(file, 'incoming Git work');
    const plan = await service.preview('p', options);
    service.onModuleInit();
    const original = git.git.bind(git) as WorkspaceGitService['git'];
    let injected = false;
    vi.spyOn(git, 'git').mockImplementation(async (...args) => {
      const output = await original(...args);
      if (!injected && args[1][0] === 'check-ignore') {
        injected = true;
        await expect(
          upload(item.id, 'concurrent local work', doc.id),
        ).rejects.toThrow('GIT_DELIVERABLES_BUSY');
        expect(() =>
          deliverables.setDocumentDeleted(
            'p',
            'board',
            item.id,
            doc.id,
            1,
            true,
          ),
        ).toThrow('GIT_DELIVERABLES_BUSY');
      }
      return output;
    });
    const applied = await service.apply('p', {
      options,
      fingerprint: plan.fingerprint,
    });
    expect(injected).toBe(true);
    expect(applied.changes).toContainEqual(
      expect.objectContaining({ action: 'import' }),
    );
    expect(await fs.readFile(file, 'utf8')).toBe('incoming Git work');
    expect(
      await fs.readFile(
        deliverables.documents('p', 'board', item.id)[0].sourcePath,
        'utf8',
      ),
    ).toBe('incoming Git work');
    expect(
      deliverables.documents('p', 'board', item.id)[0].versions,
    ).toHaveLength(2);
  });
  it('rejects a plan when an unlocked local save completes during its asynchronous inspection', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'During preview',
    });
    const doc = await upload(item.id, 'base');
    await sync();
    const original = git.git.bind(git) as WorkspaceGitService['git'];
    let injected = false;
    vi.spyOn(git, 'git').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!injected && args[1][0] === 'check-ignore') {
        injected = true;
        await upload(item.id, 'new local', doc.id);
      }
      return result;
    });
    await expect(service.preview('p', options)).rejects.toThrow(
      'GIT_DELIVERABLES_CHANGED',
    );
    expect(
      deliverables.documents('p', 'board', item.id)[0].currentVersionNumber,
    ).toBe(2);
    expect(
      await fs.readFile(
        path.join(repo, 'livrables', item.id, 'notes.md'),
        'utf8',
      ),
    ).toBe('base');
  });
  it('excludes another request from metadata import and rejects stale organization revisions', async () => {
    const externalRequest = new AsyncResource('independent-request');
    try {
      const remote = await external(['Initial']);
      await sync();
      const item = deliverables.board('p', 'board').deliverables[0];
      const oldRevision = organization.read('p', 'board', item.id).revision;
      remote.manifest.labels = ['Remote'];
      remote.manifest.documents[0].labels = ['Remote'];
      await fs.writeFile(
        path.join(remote.folder, 'livrable.json'),
        JSON.stringify(remote.manifest),
      );
      await fs.writeFile(
        path.join(remote.folder, 'notes.md'),
        'incoming second version',
      );
      const plan = await service.preview('p', options);
      service.onModuleInit();
      const original = deliverables.uploadDocuments.bind(
        deliverables,
      ) as DeliverablesService['uploadDocuments'];
      let guarded = false;
      vi.spyOn(deliverables, 'uploadDocuments').mockImplementationOnce(
        (...args) => {
          externalRequest.runInAsyncScope(() => {
            expect(() =>
              organization.createLabel('p', 'board', item.id, {
                name: 'Concurrent',
                expectedRevision: oldRevision,
              }),
            ).toThrow('GIT_DELIVERABLES_BUSY');
            guarded = true;
          });
          return original(...args);
        },
      );
      await service.apply('p', { options, fingerprint: plan.fingerprint });
      expect(guarded).toBe(true);
      expect(
        organization.read('p', 'board', item.id).labels.map((l) => l.name),
      ).toEqual(['Remote']);
      organization.createLabel('p', 'board', item.id, {
        name: 'Concurrent',
        expectedRevision: organization.read('p', 'board', item.id).revision,
      });
      expect(() =>
        organization.importGitOrganization(
          'p',
          'board',
          item.id,
          ['Overwrite'],
          {},
          oldRevision,
        ),
      ).toThrow('DOCUMENT_ORGANIZATION_CHANGED');
      expect(
        organization.read('p', 'board', item.id).labels.map((l) => l.name),
      ).toContain('Concurrent');
    } finally {
      externalRequest.emitDestroy();
    }
  });
  it('binds the accepted plan to the branch and HEAD and keeps comparison baselines per branch', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Branches' });
    const doc = await upload(item.id, 'base');
    await sync();
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'Base',
    ]);
    const initialBranch = execFileSync('git', [
      '-C',
      repo,
      'branch',
      '--show-current',
    ])
      .toString()
      .trim();
    execFileSync('git', ['-C', repo, 'branch', 'other']);
    const plan = await service.preview('p', options);
    execFileSync('git', ['-C', repo, 'checkout', '-q', 'other']);
    await expect(
      service.apply('p', { options, fingerprint: plan.fingerprint }),
    ).rejects.toThrow('GIT_DELIVERABLES_CHANGED');
    expect(
      await fs.readFile(
        path.join(repo, 'livrables', item.id, 'notes.md'),
        'utf8',
      ),
    ).toBe('base');
    await sync();
    await upload(item.id, 'new branch version', doc.id);
    await sync();
    execFileSync('git', ['-C', repo, 'reset', '--hard', 'HEAD']);
    execFileSync('git', ['-C', repo, 'checkout', '-q', initialBranch]);
    expect((await service.preview('p', options)).changes).toContainEqual(
      expect.objectContaining({ action: 'export', reason: 'document' }),
    );
    const headPlan = await service.preview('p', options);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'New head',
    ]);
    await expect(
      service.apply('p', { options, fingerprint: headPlan.fingerprint }),
    ).rejects.toThrow('GIT_DELIVERABLES_CHANGED');
  });
  it('durably marks a delayed change during export and runs a follow-up before clearing pending', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Pending' });
    const doc = await upload(item.id, 'base');
    await sync();
    await upload(item.id, 'version two', doc.id);
    service.onModuleInit();
    const plan = await service.preview('p', options);
    const original = gitFormat.writeGitFile;
    vi.spyOn(gitFormat, 'writeGitFile').mockImplementationOnce(
      async (...args) => {
        deliverables.onGitChange?.('p', 'board');
        return original(...args);
      },
    );
    await service.apply('p', { options, fingerprint: plan.fingerprint });
    expect((await service.status('p')).copies[0].pending).toBe(true);
    await vi.waitFor(async () =>
      expect((await service.status('p')).copies[0].pending).toBe(false),
    );
    expect(
      await fs.readFile(
        path.join(repo, 'livrables', item.id, 'notes.md'),
        'utf8',
      ),
    ).toBe('version two');
  });
  it('keeps interrupted pending work visible after restart without borrowing an identity', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Restart' });
    const doc = await upload(item.id, 'base');
    await sync();
    service.onModuleInit();
    await upload(item.id, 'pending version', doc.id);
    service.onModuleDestroy();
    expect((await service.status('p')).copies[0].pending).toBe(true);
    // No startup execution under a missing/reused browser identity; explicit review resumes it.
    const plan = await service.preview('p', options);
    await service.apply('p', { options, fingerprint: plan.fingerprint });
    expect((await service.status('p')).copies[0].pending).toBe(false);
  });
  it('resumes an interrupted first export without interpreting the unfinished manifest as a deletion', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'Partial export',
    });
    await upload(item.id, 'retained');
    const plan = await service.preview('p', options);
    const original = gitFormat.writeGitFile;
    const writer = vi
      .spyOn(gitFormat, 'writeGitFile')
      .mockImplementation(async (...args) => {
        if (args[1].endsWith('/livrable.json'))
          throw new Error('Synthetic interruption');
        return original(...args);
      });
    await expect(
      service.apply('p', { options, fingerprint: plan.fingerprint }),
    ).rejects.toThrow('Synthetic interruption');
    writer.mockRestore();
    const retry = await service.preview('p', options);
    expect(retry.canApply).toBe(true);
    await service.apply('p', { options, fingerprint: retry.fingerprint });
    expect(
      await fs.readFile(
        path.join(repo, 'livrables', item.id, 'notes.md'),
        'utf8',
      ),
    ).toBe('retained');
    expect(
      deliverables.documents('p', 'board', item.id)[0].versions,
    ).toHaveLength(1);
    await fs.rm(path.join(repo, 'livrables', item.id, 'livrable.json'));
    expect((await service.preview('p', options)).changes).toContainEqual(
      expect.objectContaining({ action: 'conflict', reason: 'removed_in_git' }),
    );
  });
  it('continues past a conflicted copy and keeps its error visible after another copy succeeds', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Copies' });
    const doc = await upload(item.id, 'base');
    await sync();
    const repo2 = path.join(root, 'second');
    await fs.mkdir(repo2);
    execFileSync('git', ['init', '--quiet', repo2]);
    copyViews.push({
      ...copyViews[0],
      id: 'copy2',
      localPath: repo2,
      ownerThreadIds: ['agent2'],
      ownerAgentIds: ['agent2'],
    });
    const second = { ...options, copyId: 'copy2' };
    const initial = await service.preview('p', second);
    await service.apply('p', {
      options: second,
      fingerprint: initial.fingerprint,
    });
    await fs.writeFile(
      path.join(repo, 'livrables', item.id, 'notes.md'),
      'diverged in first copy',
    );
    service.onModuleInit();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const finished = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const originalApply = service.apply.bind(
      service,
    ) as GitDeliverablesService['apply'];
    vi.spyOn(service, 'apply').mockImplementation((...args) => {
      expect(args[1].options).toMatchObject({ copyId: 'copy2' });
      const operation = originalApply(...args);
      void operation.then(
        () => resolve(),
        (error: unknown) => reject(error),
      );
      return operation;
    });
    await upload(item.id, 'new common version', doc.id);
    await finished;
    expect(
      await fs.readFile(
        path.join(repo2, 'livrables', item.id, 'notes.md'),
        'utf8',
      ),
    ).toBe('new common version');
    const status = await service.status('p');
    expect(status.copies[0].lastError).toBe('GIT_DELIVERABLES_REVIEW_REQUIRED');
    expect(status.copies[1].lastError).toBeNull();
    expect(status.copies[1].pending).toBe(false);
    expect(status.boards[0].settings?.lastError).toBe(
      'GIT_DELIVERABLES_REVIEW_REQUIRED',
    );
  });
  it('replans a delayed export on the selected branch when its bytes are a known older version', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'Delayed branch',
    });
    const doc = await upload(item.id, 'base');
    await sync();
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'Base',
    ]);
    execFileSync('git', ['-C', repo, 'branch', 'elsewhere']);
    service.onModuleInit();
    await upload(item.id, 'current Mergeron version', doc.id);
    execFileSync('git', ['-C', repo, 'checkout', '-q', 'elsewhere']);
    await vi.waitFor(
      async () => {
        expect(
          await fs.readFile(
            path.join(repo, 'livrables', item.id, 'notes.md'),
            'utf8',
          ),
        ).toBe('current Mergeron version');
      },
      { timeout: 4000 },
    );
    expect((await service.status('p')).copies[0].lastError).toBeNull();
    expect(
      deliverables.documents('p', 'board', item.id)[0].currentVersionNumber,
    ).toBe(2);
  });
  it('does not invalidate an approved plan when another copy only updates its error status', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'Independent status',
    });
    const doc = await upload(item.id, 'base');
    await sync();
    await upload(item.id, 'next', doc.id);
    const otherRepo = path.join(root, 'status-only-copy');
    await fs.mkdir(otherRepo);
    execFileSync('git', ['init', '--quiet', otherRepo]);
    copyViews.push({
      ...copyViews[0],
      id: 'other',
      localPath: otherRepo,
      ownerThreadIds: ['other-agent'],
      ownerAgentIds: ['other-agent'],
    });
    const plan = await service.preview('p', options);
    const board = database.db
      .select()
      .from(schema.projectResources)
      .where(eq(schema.projectResources.id, 'board'))
      .get()!;
    const configuration = structuredClone(board.config);
    const settings = configuration.gitDeliverables as {
      copies: Record<
        string,
        {
          bindings: object;
          lastError: string | null;
          lastSyncAt: number | null;
        }
      >;
    };
    settings.copies.other = {
      bindings: {},
      lastError: 'GIT_DELIVERABLES_REVIEW_REQUIRED',
      lastSyncAt: null,
    };
    database.db
      .update(schema.projectResources)
      .set({ config: configuration })
      .where(eq(schema.projectResources.id, 'board'))
      .run();
    await service.apply('p', { options, fingerprint: plan.fingerprint });
    expect(
      await fs.readFile(
        path.join(repo, 'livrables', item.id, 'notes.md'),
        'utf8',
      ),
    ).toBe('next');
    expect((await service.status('p')).boards[0].settings?.lastError).toBe(
      'GIT_DELIVERABLES_REVIEW_REQUIRED',
    );
  });
  it('resumes removal after the file moved but before its manifest was saved', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'Interrupted removal',
    });
    const doc = await upload(item.id, 'retained bytes');
    await sync();
    deliverables.setDocumentDeleted('p', 'board', item.id, doc.id, 1, true);
    const plan = await service.preview('p', options);
    const original = gitFormat.writeGitFile;
    let interrupted = false;
    vi.spyOn(gitFormat, 'writeGitFile').mockImplementation(async (...args) => {
      if (!interrupted && args[1].endsWith('/livrable.json')) {
        interrupted = true;
        throw new Error('Interrupted manifest save');
      }
      return original(...args);
    });
    await expect(
      service.apply('p', { options, fingerprint: plan.fingerprint }),
    ).rejects.toThrow('Interrupted manifest save');
    expect(interrupted).toBe(true);
    await expect(
      fs.stat(path.join(repo, 'livrables', item.id, 'notes.md')),
    ).rejects.toThrow();
    const retry = await service.preview('p', options);
    expect(retry.canApply).toBe(true);
    await service.apply('p', { options, fingerprint: retry.fingerprint });
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(repo, 'livrables', item.id, 'livrable.json'),
        'utf8',
      ),
    ) as { documents: unknown[] };
    expect(manifest.documents).toEqual([]);
    const backups = (
      await fs.readdir(path.join(repo, '.git', 'mergeron-deliverable-recovery'))
    ).filter((f) => !f.endsWith('.json'));
    expect(backups).toHaveLength(1);
    expect(
      await fs.readFile(
        path.join(repo, '.git', 'mergeron-deliverable-recovery', backups[0]),
        'utf8',
      ),
    ).toBe('retained bytes');
    expect(
      deliverables.documents('p', 'board', item.id)[0].deletedAt,
    ).not.toBeNull();
  });
  it('keeps portable document identity through deletion and restoration without repeated exports', async () => {
    const { folder } = await external();
    await sync();
    const item = deliverables.board('p', 'board').deliverables[0];
    const document = deliverables.documents('p', 'board', item.id)[0];
    deliverables.setDocumentDeleted(
      'p',
      'board',
      item.id,
      document.id,
      1,
      true,
    );
    await sync();
    expect((await service.preview('p', options)).changes).toEqual([]);
    deliverables.setDocumentDeleted(
      'p',
      'board',
      item.id,
      document.id,
      1,
      false,
    );
    await sync();
    const manifest = JSON.parse(
      await fs.readFile(path.join(folder, 'livrable.json'), 'utf8'),
    ) as { documents: { id: string }[] };
    expect(manifest.documents.map((entry) => entry.id)).toEqual(['text']);
    expect(deliverables.documents('p', 'board', item.id)).toHaveLength(1);
    expect((await service.preview('p', options)).changes).toEqual([]);
  });
});
