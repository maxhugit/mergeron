import {
  manifestSchema,
  readableDeliverableFolder,
} from '../deliverables/git-deliverables-format';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
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
  async function namedDocument(id: string, name: string, text: string) {
    async function* data() {
      await Promise.resolve();
      yield { filename: name, stream: Readable.from(text) };
    }
    await deliverables.uploadDocuments('p', 'board', id, data(), {});
    return deliverables
      .documents('p', 'board', id)
      .find((document) => document.name === name)!;
  }
  it.each(['mergeron', 'git'] as const)(
    'resolves only the confirmed document toward %s and preserves the replaced content',
    async (direction) => {
      const item = await deliverables.create('p', 'board', {
        title: 'Resolve one',
      });
      const doc = await upload(item.id, 'common');
      await sync();
      await upload(item.id, 'Mergeron chosen', doc.id);
      const folder = path.join(
        repo,
        'livrables',
        readableDeliverableFolder(item.title),
      );
      const target = path.join(folder, 'notes.md');
      await fs.writeFile(target, 'Git chosen');
      await namedDocument(
        item.id,
        'unrelated.md',
        'not part of this correction',
      );
      const preview = await service.previewDocument('p', {
        options,
        documentId: doc.id,
      });
      expect(preview.actions).toEqual(['mergeron', 'git']);
      expect(preview.mergeron.sha256).not.toBe(preview.git.sha256);
      await expect(
        service.apply('p', {
          options,
          fingerprint: preview.fingerprint,
          resolution: { documentId: doc.id, direction },
        }),
      ).rejects.toThrow();
      const result = await service.apply('p', {
        options,
        fingerprint: preview.fingerprint,
        resolution: {
          documentId: doc.id,
          direction,
          confirmation: 'CONFIRM_DOCUMENT_RESOLUTION',
        },
      });
      const current = deliverables
        .documents('p', 'board', item.id)
        .find((candidate) => candidate.id === doc.id)!;
      const chosen =
        direction === 'mergeron' ? 'Mergeron chosen' : 'Git chosen';
      expect(await fs.readFile(target, 'utf8')).toBe(chosen);
      expect(await fs.readFile(current.sourcePath, 'utf8')).toBe(chosen);
      await expect(
        fs.stat(path.join(folder, 'unrelated.md')),
      ).rejects.toThrow();
      expect(result.remaining).toContainEqual(
        expect.objectContaining({ action: 'export', document: 'unrelated.md' }),
      );
      if (direction === 'mergeron') {
        const recovery = path.join(
          repo,
          '.git',
          'mergeron-deliverable-recovery',
        );
        const files = await fs.readdir(recovery);
        const retained = files.find((file) => !file.endsWith('.json'))!;
        expect(await fs.readFile(path.join(recovery, retained), 'utf8')).toBe(
          'Git chosen',
        );
      } else {
        expect(current.currentVersionNumber).toBe(3);
        expect(
          await fs.readFile(
            current.versions.find((version) => version.number === 2)!
              .snapshotPath,
            'utf8',
          ),
        ).toBe('Mergeron chosen');
      }
      await expect(
        service.apply('p', {
          options,
          fingerprint: preview.fingerprint,
          resolution: {
            documentId: doc.id,
            direction,
            confirmation: 'CONFIRM_DOCUMENT_RESOLUTION',
          },
        }),
      ).rejects.toThrow('GIT_DELIVERABLES_CHANGED');
    },
  );
  it('refuses a stale comparison, an unrelated document or an ignored path for document correction', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'Protection',
    });
    const doc = await upload(item.id, 'common');
    await sync();
    await expect(
      service.previewDocument('p', { options, documentId: 'unknown' }),
    ).rejects.toThrow('GIT_DELIVERABLES_DOCUMENT_UNAVAILABLE');
    const preview = await service.previewDocument('p', {
      options,
      documentId: doc.id,
    });
    const target = path.join(repo, 'livrables', 'protection', 'notes.md');
    await fs.writeFile(target, 'late edit');
    await expect(
      service.apply('p', {
        options,
        fingerprint: preview.fingerprint,
        resolution: {
          documentId: doc.id,
          direction: 'mergeron',
          confirmation: 'CONFIRM_DOCUMENT_RESOLUTION',
        },
      }),
    ).rejects.toThrow('GIT_DELIVERABLES_CHANGED');
    await fs.writeFile(
      path.join(repo, '.gitignore'),
      'livrables/protection/notes.md\n',
    );
    const blocked = await service.previewDocument('p', {
      options,
      documentId: doc.id,
    });
    expect(blocked.actions).toEqual([]);
    await expect(
      service.apply('p', {
        options,
        fingerprint: blocked.fingerprint,
        resolution: {
          documentId: doc.id,
          direction: 'mergeron',
          confirmation: 'CONFIRM_DOCUMENT_RESOLUTION',
        },
      }),
    ).rejects.toThrow('GIT_DELIVERABLES_RESOLUTION_UNAVAILABLE');
    expect(await fs.readFile(target, 'utf8')).toBe('late edit');
  });
  it('explicitly imports a safe document without resolving or overwriting its conflicting sibling', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'Independent imports',
    });
    const blocked = await upload(item.id, 'common first');
    const incoming = await namedDocument(
      item.id,
      'incoming.md',
      'common incoming',
    );
    await sync();
    await upload(item.id, 'local first', blocked.id);
    const folder = path.join(
      repo,
      'livrables',
      readableDeliverableFolder(item.title),
    );
    await fs.writeFile(path.join(folder, 'notes.md'), 'conflicting Git first');
    await fs.writeFile(path.join(folder, 'incoming.md'), 'new Git incoming');
    const plan = await service.preview('p', options);
    expect(plan.canApply).toBe(true);
    const result = await service.apply('p', {
      options,
      fingerprint: plan.fingerprint,
    });
    const documents = deliverables.documents('p', 'board', item.id);
    const imported = documents.find((doc) => doc.id === incoming.id)!;
    expect(imported.currentVersionNumber).toBe(2);
    expect(await fs.readFile(imported.sourcePath, 'utf8')).toBe(
      'new Git incoming',
    );
    expect(
      await fs.readFile(
        documents.find((doc) => doc.id === blocked.id)!.sourcePath,
        'utf8',
      ),
    ).toBe('local first');
    expect(await fs.readFile(path.join(folder, 'notes.md'), 'utf8')).toBe(
      'conflicting Git first',
    );
    expect(result.remaining).toContainEqual(
      expect.objectContaining({ action: 'conflict', document: 'notes.md' }),
    );
    expect(result.changes).toContainEqual(
      expect.objectContaining({ action: 'import', document: 'incoming.md' }),
    );
    expect(result.changes.some((change) => change.action === 'conflict')).toBe(
      false,
    );
  });
  it('automatically exports clean sibling documents and other deliverables while preserving a conflicting document', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Cadrage' });
    const blocked = await upload(item.id, 'common');
    await sync();
    await upload(item.id, 'Mergeron changed', blocked.id);
    const folder = path.join(
      repo,
      'livrables',
      readableDeliverableFolder(item.title),
    );
    await fs.writeFile(path.join(folder, 'notes.md'), 'Git changed');
    const clean = await namedDocument(
      item.id,
      'new.md',
      'independent document',
    );
    const other = await deliverables.create('p', 'board', {
      title: 'Maquette',
    });
    await upload(other.id, 'independent mockup');
    service.onModuleInit();
    service.reconcile('p');
    await vi.waitFor(
      async () => {
        expect(await fs.readFile(path.join(folder, 'new.md'), 'utf8')).toBe(
          'independent document',
        );
        expect(
          await fs.readFile(
            path.join(repo, 'livrables', 'maquette', 'notes.md'),
            'utf8',
          ),
        ).toBe('independent mockup');
        expect((await service.status('p', 'copy')).active).toBe(false);
      },
      { timeout: 5000, interval: 50 },
    );
    expect(await fs.readFile(path.join(folder, 'notes.md'), 'utf8')).toBe(
      'Git changed',
    );
    const remaining = await service.preview('p', options);
    expect(remaining.changes).toContainEqual(
      expect.objectContaining({ action: 'conflict', document: 'notes.md' }),
    );
    expect(
      remaining.changes.some((change) => change.documentId === clean.id),
    ).toBe(false);
    expect(
      remaining.changes.some((change) => change.deliverableId === other.id),
    ).toBe(false);
    expect((await service.status('p', 'copy')).copies[0].lastError).toBe(
      'GIT_DELIVERABLES_REVIEW_REQUIRED',
    );
  });
  it('exports new documents without adopting unverified deliverable metadata or overwriting an untracked collision', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'Unknown baseline',
    });
    await upload(item.id, 'identical content');
    await sync();
    const folder = path.join(
      repo,
      'livrables',
      readableDeliverableFolder(item.title),
    );
    const metadataPath = path.join(folder, 'livrable.json');
    const original = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as {
      description: string;
    };
    original.description = 'Unreviewed Git description';
    await fs.writeFile(metadataPath, JSON.stringify(original));
    const row = database.db
      .select()
      .from(schema.projectResources)
      .where(eq(schema.projectResources.id, 'board'))
      .get()!;
    const config = structuredClone(row.config);
    const settings = config.gitDeliverables as {
      copies: Record<
        string,
        { bindings: Record<string, unknown>; branches?: unknown }
      >;
    };
    settings.copies.copy.bindings = {};
    delete settings.copies.copy.branches;
    database.db
      .update(schema.projectResources)
      .set({ config })
      .where(eq(schema.projectResources.id, 'board'))
      .run();
    const safe = await namedDocument(item.id, 'safe.md', 'safe content');
    const collision = await namedDocument(
      item.id,
      'collision.md',
      'local collision',
    );
    await namedDocument(item.id, 'ignored.md', 'never export ignored content');
    await fs.writeFile(
      path.join(repo, '.gitignore'),
      'livrables/unknown-baseline/ignored.md\n',
    );
    await fs.writeFile(
      path.join(folder, 'collision.md'),
      'untracked Git content',
    );
    const plan = await service.preview('p', options);
    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        action: 'conflict',
        reason: 'metadata_baseline_missing',
      }),
    );
    expect(plan.changes).toContainEqual(
      expect.objectContaining({ action: 'conflict', documentId: collision.id }),
    );
    await service.apply('p', { options, fingerprint: plan.fingerprint }, true);
    expect(await fs.readFile(path.join(folder, 'safe.md'), 'utf8')).toBe(
      'safe content',
    );
    expect(await fs.readFile(path.join(folder, 'collision.md'), 'utf8')).toBe(
      'untracked Git content',
    );
    await expect(fs.stat(path.join(folder, 'ignored.md'))).rejects.toThrow();
    const manifest = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as {
      description: string;
      documents: { path: string }[];
    };
    expect(manifest.description).toBe('Unreviewed Git description');
    expect(manifest.documents.map((document) => document.path)).toContain(
      'safe.md',
    );
    expect(manifest.documents.map((document) => document.path)).not.toContain(
      'collision.md',
    );
    const remaining = await service.preview('p', options);
    expect(
      remaining.changes.some((change) => change.documentId === safe.id),
    ).toBe(false);
    expect(remaining.changes).toContainEqual(
      expect.objectContaining({ action: 'conflict', documentId: collision.id }),
    );
  });
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
        path.join(
          repo,
          'livrables',
          readableDeliverableFolder(item.title),
          'notes.md',
        ),
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
      path.join(
        publisher,
        'livrables',
        readableDeliverableFolder(item.title),
        'notes.md',
      ),
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
    const file = path.join(
      repo,
      'livrables',
      readableDeliverableFolder(item.title),
      'notes.md',
    );
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
        path.join(
          repo,
          'livrables',
          readableDeliverableFolder(item.title),
          'notes.md',
        ),
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
  it('exports existing documents after enabling the mode without another edit or manual synchronization', async () => {
    service.onModuleInit();
    const item = await deliverables.create('p', 'board', {
      title: 'Predates Git mode',
    });
    const doc = await upload(item.id, 'retained before activation');
    await expect(fs.stat(path.join(repo, 'livrables'))).rejects.toThrow();
    expect(
      service.configure('p', {
        boardId: 'board',
        directory: 'livrables',
        enabled: true,
      }),
    ).toEqual({ enabled: true });
    expect((await service.status('p')).copies[0].pending).toBe(true);
    await vi.waitFor(
      async () => {
        expect(
          await fs.readFile(
            path.join(
              repo,
              'livrables',
              readableDeliverableFolder(item.title),
              'notes.md',
            ),
            'utf8',
          ),
        ).toBe('retained before activation');
        expect((await service.status('p')).copies[0]).toMatchObject({
          pending: false,
          lastError: null,
        });
      },
      { timeout: 4000 },
    );
    expect(deliverables.documents('p', 'board', item.id)).toEqual([doc]);
  });
  it('keeps both contents when enabling the mode encounters a concurrent Git edit', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'Conflict at activation',
    });
    const doc = await upload(item.id, 'common version');
    await sync();
    service.disable('p', 'board');
    await upload(item.id, 'new Mergeron work', doc.id);
    const file = path.join(
      repo,
      'livrables',
      readableDeliverableFolder(item.title),
      'notes.md',
    );
    await fs.writeFile(file, 'new Git work');
    service.onModuleInit();
    service.configure('p', {
      boardId: 'board',
      directory: 'livrables',
      enabled: true,
    });
    await vi.waitFor(
      async () => {
        expect((await service.status('p')).copies[0].lastError).toBe(
          'GIT_DELIVERABLES_REVIEW_REQUIRED',
        );
      },
      { timeout: 4000 },
    );
    expect(await fs.readFile(file, 'utf8')).toBe('new Git work');
    const retained = deliverables.documents('p', 'board', item.id)[0];
    expect(retained.currentVersionNumber).toBe(2);
    expect(await fs.readFile(retained.sourcePath, 'utf8')).toBe(
      'new Mergeron work',
    );
  });
  it('exports an HTML deletion as an unstaged Git removal and can restore it from Mergeron', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'HTML cleanup',
    });
    async function* data() {
      await Promise.resolve();
      yield { filename: 'page.html', stream: Readable.from('<p>retained</p>') };
    }
    await deliverables.uploadDocuments('p', 'board', item.id, data(), {});
    const doc = deliverables.documents('p', 'board', item.id)[0];
    await sync();
    const run = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...args]).toString();
    run(['add', '.']);
    run([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'Exported HTML',
    ]);
    const head = run(['rev-parse', 'HEAD']);
    service.onModuleInit();
    deliverables.setDocumentDeleted('p', 'board', item.id, doc.id, 1, true);
    const relative = `livrables/${readableDeliverableFolder(item.title)}/page.html`;
    await vi.waitFor(
      async () => {
        expect((await service.status('p')).copies[0]).toMatchObject({
          pending: false,
          lastError: null,
        });
        await expect(fs.stat(path.join(repo, relative))).rejects.toThrow();
      },
      { timeout: 4000 },
    );
    expect(run(['diff', '--name-status'])).toContain('D\t' + relative);
    expect(run(['diff', '--cached', '--name-only'])).toBe('');
    expect(run(['rev-parse', 'HEAD'])).toBe(head);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(
          repo,
          'livrables',
          readableDeliverableFolder(item.title),
          'livrable.json',
        ),
        'utf8',
      ),
    ) as { documents: unknown[] };
    expect(manifest.documents).toEqual([]);
    expect(await fs.readFile(doc.sourcePath, 'utf8')).toBe('<p>retained</p>');
    deliverables.setDocumentDeleted('p', 'board', item.id, doc.id, 1, false);
    await vi.waitFor(
      async () => {
        expect((await service.status('p')).copies[0]).toMatchObject({
          pending: false,
          lastError: null,
        });
        expect(await fs.readFile(path.join(repo, relative), 'utf8')).toBe(
          '<p>retained</p>',
        );
      },
      { timeout: 4000 },
    );
    expect(run(['status', '--porcelain'])).toBe('');
  });
  it('does not remove or reimport Git-only edits after an explicit Mergeron deletion', async () => {
    const item = await deliverables.create('p', 'board', {
      title: 'Deletion conflict',
    });
    const doc = await upload(item.id, 'common');
    await sync();
    const file = path.join(
      repo,
      'livrables',
      readableDeliverableFolder(item.title),
      'notes.md',
    );
    await fs.writeFile(file, 'precious Git work');
    deliverables.setDocumentDeleted('p', 'board', item.id, doc.id, 1, true);
    const preview = await service.preview('p', options);
    expect(preview.canApply).toBe(false);
    expect(preview.changes).toContainEqual(
      expect.objectContaining({
        action: 'conflict',
        reason: 'deleted_document_changed_in_git',
      }),
    );
    await expect(
      service.apply('p', { options, fingerprint: preview.fingerprint }),
    ).rejects.toThrow('GIT_DELIVERABLES_CONFLICTS');
    expect(await fs.readFile(file, 'utf8')).toBe('precious Git work');
    expect(
      deliverables.documents('p', 'board', item.id)[0].deletedAt,
    ).not.toBeNull();
    expect(
      deliverables.documents('p', 'board', item.id)[0].versions,
    ).toHaveLength(1);
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
            path.join(
              repo,
              'livrables',
              readableDeliverableFolder(item.title),
              'notes.md',
            ),
            'utf8',
          ),
        ).toBe('retained while waiting');
        const state = (await service.status('p')).copies[0];
        expect(state).toMatchObject({ pending: false, lastError: null });
        expect(state.lastSyncAt).toBeTypeOf('number');
      },
      { timeout: 4000 },
    );
    expect(
      deliverables.documents('p', 'board', item.id)[0].currentVersionNumber,
    ).toBe(1);
  });
  it('exports local-only document additions on a fresh branch using a verified manifest from the same identity', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Cadrage' });
    await upload(item.id, 'retained base');
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
      'Baseline',
    ]);
    const folder = path.join(repo, 'livrables', 'cadrage');
    const before = await fs.readFile(
      path.join(folder, 'livrable.json'),
      'utf8',
    );
    async function* addition() {
      await Promise.resolve();
      yield {
        filename: 'new-document.md',
        stream: Readable.from('only added in Mergeron'),
      };
    }
    await deliverables.uploadDocuments('p', 'board', item.id, addition(), {});
    expect((await service.preview('p', options)).canApply).toBe(true);
    execFileSync('git', [
      '-C',
      repo,
      'checkout',
      '-q',
      '-b',
      'another-agent-branch',
    ]);
    const plan = await service.preview('p', options);
    expect(await fs.readFile(path.join(folder, 'livrable.json'), 'utf8')).toBe(
      before,
    );
    expect(
      execFileSync('git', ['-C', repo, 'status', '--porcelain']).toString(),
    ).toBe('');
    expect(plan.canApply).toBe(true);
    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        action: 'export',
        reason: 'known_older_metadata',
      }),
    );
    expect(
      plan.changes.some(
        (change) => change.action === 'import' || change.action === 'conflict',
      ),
    ).toBe(false);
    await service.apply('p', { options, fingerprint: plan.fingerprint });
    expect(
      await fs.readFile(path.join(folder, 'new-document.md'), 'utf8'),
    ).toBe('only added in Mergeron');
    expect(deliverables.documents('p', 'board', item.id)).toHaveLength(2);
    expect(
      deliverables
        .documents('p', 'board', item.id)
        .every((document) => document.currentVersionNumber === 1),
    ).toBe(true);
    expect((await service.preview('p', options)).changes).toEqual([]);
    expect(
      execFileSync('git', [
        '-C',
        repo,
        'diff',
        '--cached',
        '--name-only',
      ]).toString(),
    ).toBe('');
    expect(
      execFileSync('git', ['-C', repo, 'log', '--format=%s']).toString().trim(),
    ).toBe('Baseline');
  });
  it('restores known older metadata from retained synchronized history rather than importing it', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Cadrage' });
    await upload(item.id, 'retained');
    await sync();
    const file = path.join(repo, 'livrables', 'cadrage', 'livrable.json');
    const older = await fs.readFile(file, 'utf8');
    const current = deliverables.get('p', 'board', item.id);
    deliverables.update('p', 'board', item.id, {
      description: 'current organization',
      version: current.version,
    });
    await sync();
    await fs.writeFile(file, older);
    const plan = await service.preview('p', options);
    expect(plan.canApply).toBe(true);
    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        action: 'export',
        reason: 'known_older_metadata',
      }),
    );
    const version = deliverables.get('p', 'board', item.id).version;
    await service.apply('p', { options, fingerprint: plan.fingerprint });
    expect(
      manifestSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')))
        .description,
    ).toBe('current organization');
    expect(deliverables.get('p', 'board', item.id)).toMatchObject({
      version,
      description: 'current organization',
    });
    expect((await service.preview('p', options)).changes).toEqual([]);
  });
  it('preserves unknown Git metadata when the new branch has no common baseline', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Cadrage' });
    await upload(item.id, 'retained');
    await sync();
    execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'unknown-branch']);
    const file = path.join(repo, 'livrables', 'cadrage', 'livrable.json');
    const external = manifestSchema.parse(
      JSON.parse(await fs.readFile(file, 'utf8')),
    );
    external.description = 'unknown Git work';
    const bytes = JSON.stringify(external);
    await fs.writeFile(file, bytes);
    const plan = await service.preview('p', options);
    expect(plan.canApply).toBe(false);
    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        action: 'conflict',
        reason: 'metadata_baseline_missing',
      }),
    );
    await expect(
      service.apply('p', { options, fingerprint: plan.fingerprint }),
    ).rejects.toThrow('GIT_DELIVERABLES_CONFLICTS');
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    expect(deliverables.get('p', 'board', item.id).description).toBe('');
  });
  it('still proposes an unknown Git-only metadata update and refuses concurrent metadata edits', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Cadrage' });
    await upload(item.id, 'retained');
    await sync();
    const file = path.join(repo, 'livrables', 'cadrage', 'livrable.json');
    const external = manifestSchema.parse(
      JSON.parse(await fs.readFile(file, 'utf8')),
    );
    external.description = 'unknown Git work';
    const bytes = JSON.stringify(external);
    await fs.writeFile(file, bytes);
    const proposed = await service.preview('p', options);
    expect(proposed.canApply).toBe(true);
    expect(proposed.changes).toContainEqual(
      expect.objectContaining({ action: 'import', reason: 'metadata' }),
    );
    expect(deliverables.get('p', 'board', item.id).description).toBe('');
    const current = deliverables.get('p', 'board', item.id);
    deliverables.update('p', 'board', item.id, {
      description: 'new Mergeron work',
      version: current.version,
    });
    const conflict = await service.preview('p', options);
    expect(conflict.canApply).toBe(false);
    expect(conflict.changes).toContainEqual(
      expect.objectContaining({
        action: 'conflict',
        reason: 'metadata_changed_both',
      }),
    );
    await expect(
      service.apply('p', { options, fingerprint: conflict.fingerprint }),
    ).rejects.toThrow('GIT_DELIVERABLES_CONFLICTS');
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    expect(deliverables.get('p', 'board', item.id).description).toBe(
      'new Mergeron work',
    );
  });
  it('recognizes synchronized metadata in a second agent clone without modifying the first clone', async () => {
    const item = await deliverables.create('p', 'board', { title: 'Cadrage' });
    await upload(item.id, 'retained base');
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
      'Baseline',
    ]);
    const second = path.join(root, 'second-agent');
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', repo, second]);
    const file = path.join('livrables', 'cadrage', 'livrable.json');
    const original = await fs.readFile(path.join(repo, file), 'utf8');
    async function* addition() {
      await Promise.resolve();
      yield {
        filename: 'new-document.md',
        stream: Readable.from('retained new document'),
      };
    }
    await deliverables.uploadDocuments('p', 'board', item.id, addition(), {});
    copyViews.push({
      ...copyViews[0],
      id: 'second-copy',
      localPath: second,
      ownerThreadIds: ['second-agent'],
      ownerAgentIds: ['second-agent'],
    });
    const secondOptions = { ...options, copyId: 'second-copy' };
    const plan = await service.preview('p', secondOptions);
    expect(plan.canApply).toBe(true);
    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        action: 'export',
        reason: 'known_older_metadata',
      }),
    );
    await service.apply('p', {
      options: secondOptions,
      fingerprint: plan.fingerprint,
    });
    expect(await fs.readFile(path.join(repo, file), 'utf8')).toBe(original);
    expect(
      execFileSync('git', ['-C', repo, 'status', '--porcelain']).toString(),
    ).toBe('');
    expect(
      await fs.readFile(
        path.join(second, 'livrables', 'cadrage', 'new-document.md'),
        'utf8',
      ),
    ).toBe('retained new document');
    expect((await service.preview('p', secondOptions)).changes).toEqual([]);
  });
});
