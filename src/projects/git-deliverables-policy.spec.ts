import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
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

describe('Mergeron-first Git projection policy', () => {
  let database: TestDatabase,
    root: string,
    repo: string,
    deliverables: DeliverablesService,
    organization: DocumentOrganizationService,
    service: GitDeliverablesService,
    git: WorkspaceGitService,
    copies: WorkspaceCopiesService;
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
    copies = {
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
  it('exports a Mergeron change when Git is still the common version', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Outgoing' });
    const doc = await upload(item.id, 'common v1');
    await sync();
    await upload(item.id, 'Mergeron v2', doc.id);
    const plan = await service.preview('p', options);
    expect(plan.changes).toContainEqual(
      expect.objectContaining({ action: 'export', reason: 'document' }),
    );
    expect(plan.changes.some((c) => c.action === 'import')).toBe(false);
    await service.apply('p', { options, fingerprint: plan.fingerprint });
    expect(
      await fs.readFile(
        path.join(repo, 'livrables', item.id, 'notes.md'),
        'utf8',
      ),
    ).toBe('Mergeron v2');
  });
  it('proposes a new Git version after a real local remote push and pull without automatic import', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Incoming' });
    await upload(item.id, 'common v1');
    await sync();
    const run = (cwd: string, args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args]);
    run(repo, ['add', '.']);
    run(repo, [
      '-c',
      'user.name=Verification',
      '-c',
      'user.email=verify@example.invalid',
      'commit',
      '-qm',
      'Base',
    ]);
    const branch = run(repo, ['branch', '--show-current']).toString().trim();
    const remote = path.join(root, 'remote.git'),
      publisher = path.join(root, 'publisher');
    execFileSync('git', ['clone', '--quiet', '--bare', repo, remote]);
    run(repo, ['remote', 'add', 'origin', remote]);
    execFileSync('git', ['clone', '--quiet', remote, publisher]);
    await fs.writeFile(
      path.join(publisher, 'livrables', item.id, 'notes.md'),
      'New work from Git server',
    );
    run(publisher, [
      '-c',
      'user.name=Verification',
      '-c',
      'user.email=verify@example.invalid',
      'commit',
      '-qam',
      'New external version',
    ]);
    run(publisher, ['push', '--quiet', 'origin', branch]);
    run(repo, ['pull', '--quiet', '--ff-only', 'origin', branch]);
    service.onModuleInit();
    let reviewed!: () => void;
    const waitingForReview = new Promise<void>((resolve) => {
      reviewed = resolve;
    });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(
      (message: unknown) => {
        if (message === 'Git deliverable copy requires review') reviewed();
      },
    );
    git.onWorkingCopyChanged?.('p', 'copy');
    await waitingForReview;
    const status = await service.status('p', 'copy');
    expect(status.copies[0].lastError).toBe('GIT_DELIVERABLES_REVIEW_REQUIRED');
    const plan = status.proposal!;
    expect(plan.changes).toContainEqual(
      expect.objectContaining({ action: 'import', reason: 'document' }),
    );
    expect(
      deliverables.documents('p', 'board', item.id)[0].currentVersionNumber,
    ).toBe(1);
    await service.apply('p', { options, fingerprint: plan.fingerprint });
    const doc = deliverables.documents('p', 'board', item.id)[0];
    expect(doc.currentVersionNumber).toBe(2);
    expect(await fs.readFile(doc.sourcePath, 'utf8')).toBe(
      'New work from Git server',
    );
  });
  it('conflicts if both Mergeron and Git changed from the common version', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Both' });
    const doc = await upload(item.id, 'common v1');
    await sync();
    await upload(item.id, 'new Mergeron work', doc.id);
    const file = path.join(repo, 'livrables', item.id, 'notes.md');
    await fs.writeFile(file, 'new Git work');
    const plan = await service.preview('p', options);
    expect(plan.canApply).toBe(false);
    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        action: 'conflict',
        reason: 'document_changed_both',
      }),
    );
    expect(await fs.readFile(file, 'utf8')).toBe('new Git work');
  });
  it('exports known old Git content on the same and a new branch without creating a Mergeron version', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'Known old branch',
    });
    const doc = await upload(item.id, 'known old v1');
    await sync();
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Verification',
      '-c',
      'user.email=verify@example.invalid',
      'commit',
      '-qm',
      'Old version',
    ]);
    const oldCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'])
      .toString()
      .trim();
    await upload(item.id, 'current Mergeron v2', doc.id);
    await sync();
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Verification',
      '-c',
      'user.email=verify@example.invalid',
      'commit',
      '-qm',
      'Current version',
    ]);
    execFileSync('git', ['-C', repo, 'reset', '--hard', oldCommit]);
    const plan = await service.preview('p', options);
    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        action: 'export',
        reason: 'known_older_document',
      }),
    );
    expect(plan.changes.some((c) => c.action === 'import')).toBe(false);
    execFileSync('git', [
      '-C',
      repo,
      'checkout',
      '-q',
      '-b',
      'old-content-branch',
      oldCommit,
    ]);
    const switched = await service.preview('p', options);
    expect(switched.canApply).toBe(true);
    expect(switched.changes).toContainEqual(
      expect.objectContaining({
        action: 'export',
        reason: 'known_older_document',
      }),
    );
    await service.apply('p', { options, fingerprint: switched.fingerprint });
    expect(
      await fs.readFile(
        path.join(repo, 'livrables', item.id, 'notes.md'),
        'utf8',
      ),
    ).toBe('current Mergeron v2');
    expect(
      deliverables.documents('p', 'board', item.id)[0].currentVersionNumber,
    ).toBe(2);
    expect(
      await fs.readFile(
        deliverables.documents('p', 'board', item.id)[0].sourcePath,
        'utf8',
      ),
    ).toBe('current Mergeron v2');
  });
  it('keeps imported portable IDs mapped to the same Mergeron document on a new branch', async () => {
    const folder = path.join(repo, 'livrables', 'external');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(
      path.join(folder, 'livrable.json'),
      JSON.stringify({
        format: 'mergeron-deliverable',
        version: 1,
        id: 'portable',
        title: 'Imported',
        description: '',
        labels: [],
        documents: [{ id: 'external-document', path: 'notes.md', labels: [] }],
      }),
    );
    await fs.writeFile(path.join(folder, 'notes.md'), 'old imported content');
    await sync();
    const item = deliverables.board('p', 'board').deliverables[0];
    const doc = deliverables.documents('p', 'board', item.id)[0];
    expect(doc.id).not.toBe('external-document');
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
      'Imported',
    ]);
    await upload(item.id, 'latest retained content', doc.id);
    await sync();
    execFileSync('git', ['-C', repo, 'reset', '--hard', 'HEAD']);
    execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'other']);
    const plan = await service.preview('p', options);
    expect(plan.canApply).toBe(true);
    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        action: 'export',
        reason: 'known_older_document',
      }),
    );
    await service.apply('p', { options, fingerprint: plan.fingerprint });
    expect(await fs.readFile(path.join(folder, 'notes.md'), 'utf8')).toBe(
      'latest retained content',
    );
    const documents = deliverables.documents('p', 'board', item.id);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ id: doc.id, currentVersionNumber: 2 });
  });
  it('saves the mode before any copy and exports retained work when a copy becomes ready', async () => {
    copyViews = [];
    service.onModuleInit();
    expect(
      service.configure('p', {
        boardId: 'board',
        directory: 'livrables',
        enabled: true,
      }),
    ).toEqual({ enabled: true });
    const item = await deliverables.create('p', 'board', { title: 'No copy' });
    await upload(item.id, 'retained while waiting');
    await expect(fs.stat(path.join(repo, 'livrables'))).rejects.toThrow();
    copyViews = [
      {
        id: 'copy',
        projectId: 'p',
        name: 'Ready',
        state: 'ready',
        sourceEnabled: true,
        sourceType: 'git',
        localPath: repo,
        accessMode: 'read_write',
        ownerThreadIds: ['agent'],
        ownerAgentIds: ['agent'],
      },
    ] as ReturnType<WorkspaceCopiesService['list']>;
    copies.onCopyReady?.('p');
    await vi.waitFor(
      async () => {
        expect(
          await fs.readFile(
            path.join(repo, 'livrables', item.id, 'notes.md'),
            'utf8',
          ),
        ).toBe('retained while waiting');
      },
      { timeout: 4000 },
    );
    expect(
      deliverables.documents('p', 'board', item.id)[0].currentVersionNumber,
    ).toBe(1);
  });
});
