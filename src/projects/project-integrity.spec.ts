import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import * as schema from '../database/schema';
import { ProjectWorkspaceLayout } from './project-workspace-layout';
import { ProjectIntegrityService } from './project-integrity.service';
import { ProjectIntegrityController } from './project-integrity.controller';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { eq } from 'drizzle-orm';

describe('project integrity', () => {
  let database: TestDatabase,
    parent: string,
    root: string,
    service: ProjectIntegrityService;
  const actor = { personId: null, name: 'Test administrator' };
  beforeEach(async () => {
    database = createTestDatabase();
    parent = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'integrity-')),
    );
    root = await new ProjectWorkspaceLayout(database.db, parent).prepare('p');
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
        id: 'primary',
        projectId: 'p',
        name: 'Main',
        path: root,
        primary: true,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    service = new ProjectIntegrityService(database.db, parent);
  });
  afterEach(async () => {
    database.sqlite.close();
    await fs.rm(parent, { recursive: true, force: true });
  });
  const correction = (
    report: Awaited<ReturnType<ProjectIntegrityService['inspect']>>,
    id: string,
  ) => ({
    fingerprint: report.fingerprint,
    issueId: id,
    confirmation: 'REPAIR_PROJECT',
  });
  it('inspects a real fresh project without writing or classifying free user files as orphans', async () => {
    await fs.mkdir(path.join(root, 'dossiers', '.aws'));
    await fs.writeFile(path.join(root, 'dossiers', 'note.txt'), 'keep');
    const before = await fs.readFile(
      path.join(root, '.mergeron-system', 'project.json'),
      'utf8',
    );
    const report = await service.inspect('p');
    expect(report.issues).toEqual([]);
    expect(
      await fs.readFile(
        path.join(root, '.mergeron-system', 'project.json'),
        'utf8',
      ),
    ).toBe(before);
    expect((await service.inspect('p')).fingerprint).toBe(report.fingerprint);
  });
  const missingReference = () => {
    database.db
      .insert(schema.projectAgentThreads)
      .values({
        threadId: 'agent',
        projectId: 'p',
        workspacePath: root,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(schema.projectActiveFolders)
      .values({
        contextType: 'agent',
        contextId: 'agent',
        projectId: 'p',
        resourceId: 'detached',
        relativePath: '',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  };
  it('identifies a detached reference and explicitly rebinds it without changing files or agent permissions', async () => {
    missingReference();
    await fs.writeFile(path.join(root, 'dossiers', 'keep.txt'), 'keep');
    const report = await service.inspect('p');
    const issue = report.issues.find(
      (i) => i.kind === 'active-folder-registration-missing',
    )!;
    expect(issue.reference).toMatchObject({
      contextType: 'agent',
      contextId: 'agent',
      resourceId: 'detached',
    });
    expect(issue.action).toBe('select-project-folder');
    expect(issue.expectedPath).toBe(path.join(root, 'dossiers'));
    await expect(
      service.repair(
        'p',
        { fingerprint: report.fingerprint, issueId: issue.id },
        actor,
      ),
    ).rejects.toThrow('confirmation');
    const next = await service.repair('p', correction(report, issue.id), actor);
    expect(next.issues).toEqual([]);
    expect(
      database.db.select().from(schema.projectActiveFolders).get(),
    ).toMatchObject({ resourceId: 'primary', relativePath: 'dossiers' });
    expect(
      database.db.select().from(schema.projectAgentThreads).get()
        ?.workspacePath,
    ).toBe(root);
    expect(
      await fs.readFile(path.join(root, 'dossiers', 'keep.txt'), 'utf8'),
    ).toBe('keep');
    expect(
      database.db.select().from(schema.projectActivity).get()?.details,
    ).toMatchObject({ reference: { resourceId: 'detached' } });
  });
  it('refuses a stale repair after the reference is changed', async () => {
    missingReference();
    const report = await service.inspect('p');
    const issue = report.issues.find(
      (i) => i.action === 'select-project-folder',
    )!;
    database.db
      .update(schema.projectActiveFolders)
      .set({ resourceId: 'primary' })
      .run();
    await expect(
      service.repair('p', correction(report, issue.id), actor),
    ).rejects.toThrow('changed');
  });
  it('does not offer a replacement if the target is a symlink or its location is detached', async () => {
    missingReference();
    database.db.delete(schema.projectLocations).run();
    expect(
      (await service.inspect('p')).issues.find(
        (i) => i.kind === 'active-folder-registration-missing',
      )?.action,
    ).toBeNull();
    await fs.rename(
      path.join(root, 'dossiers'),
      path.join(parent, 'kept-folders'),
    );
    await fs.symlink(parent, path.join(root, 'dossiers'));
    expect(
      (await service.inspect('p')).issues.every(
        (i) => i.action !== 'select-project-folder',
      ),
    ).toBe(true);
  });
  it('reports a symlink without reading or enumerating its target', async () => {
    const outside = path.join(parent, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
    const published = path.join(root, '.mergeron-system', 'livrables');
    await fs.rmdir(published);
    await fs.symlink(outside, published);
    const report = await service.inspect('p');
    expect(report.issues.some((i) => i.kind === 'symbolic-link')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('secret.txt');
    expect(report.issues.every((i) => !i.action)).toBe(true);
  });
  it('does not inspect an unexpected database root', async () => {
    database.db
      .update(schema.projects)
      .set({ workspacePath: parent })
      .where(eq(schema.projects.id, 'p'))
      .run();
    expect((await service.inspect('p')).issues.map((i) => i.kind)).toEqual([
      'project-location-mismatch',
    ]);
  });
  it('requires explicit confirmation and rejects a changed diagnostic', async () => {
    await fs.rename(
      path.join(root, 'dossiers'),
      path.join(parent, 'kept-dossiers'),
    );
    const report = await service.inspect('p');
    const issue = report.issues.find((i) => i.kind === 'directory-missing')!;
    await expect(
      service.repair(
        'p',
        { fingerprint: report.fingerprint, issueId: issue.id },
        actor,
      ),
    ).rejects.toThrow('confirmation');
    await fs.mkdir(path.join(root, 'dossiers'));
    await expect(
      service.repair('p', correction(report, issue.id), actor),
    ).rejects.toThrow('changed');
  });
  it.runIf(process.platform === 'linux')(
    'recreates only one missing empty directory and records its author',
    async () => {
      await fs.rename(
        path.join(root, 'dossiers'),
        path.join(parent, 'kept-dossiers'),
      );
      const report = await service.inspect('p');
      const issue = report.issues.find((i) => i.action === 'create-directory')!;
      const next = await service.repair(
        'p',
        correction(report, issue.id),
        actor,
      );
      expect(next.issues).toEqual([]);
      const activity = database.db
        .select()
        .from(schema.projectActivity)
        .all()
        .find((a) => a.action === 'integrity.repair');
      expect(activity?.actorName).toBe(actor.name);
      await expect(
        service.repair('p', correction(report, issue.id), actor),
      ).rejects.toThrow('changed');
    },
  );
  it('keeps an unregistered deliverable file intact and refuses automatic adoption', async () => {
    const orphan = path.join(
      root,
      '.mergeron-system',
      'livrables',
      'unregistered.txt',
    );
    await fs.writeFile(orphan, 'keep');
    const report = await service.inspect('p');
    const issue = report.issues.find(
      (i) => i.kind === 'unregistered-document',
    )!;
    expect(issue.action).toBeNull();
    await expect(
      service.repair('p', correction(report, issue.id), actor),
    ).rejects.toThrow('No safe');
    expect(await fs.readFile(orphan, 'utf8')).toBe('keep');
    expect(
      database.db.select().from(schema.projectDeliverableDocuments).all(),
    ).toEqual([]);
  });
  it('realigns a verified legacy agent reference without moving data or changing preferences', async () => {
    const old = path.join(root, 'documents');
    const current = path.join(root, 'dossiers');
    database.db
      .insert(schema.projectAgentThreads)
      .values({
        threadId: 'agent',
        projectId: 'p',
        workspacePath: old,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const preferences = {
      key: 'thread-execution-preferences:agent',
      value: '{"security":{"approvalPolicy":"never"}}',
      type: 'json' as const,
      category: 'test',
      description: 'test',
      defaultValue: '',
      constraints: '{}',
      updatedAt: 1,
    };
    database.db.insert(schema.settings).values(preferences).run();
    const report = await service.inspect('p');
    const issue = report.issues.find(
      (i) => i.kind === 'agent-reference-obsolete',
    )!;
    expect(issue.expectedPath).toBe(current);
    await service.repair('p', correction(report, issue.id), actor);
    expect(
      database.db.select().from(schema.projectAgentThreads).get()
        ?.workspacePath,
    ).toBe(current);
    expect(
      database.db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, preferences.key))
        .get()?.value,
    ).toBe(preferences.value);
    expect(await fs.stat(current)).toBeTruthy();
  });
  it('never recreates a declared document or its missing nonempty deliverable directory', async () => {
    database.db
      .insert(schema.projectResources)
      .values({
        id: 'board',
        projectId: 'p',
        type: 'deliverable_board',
        name: 'Board',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(schema.projectDeliverables)
      .values({
        id: 'd',
        resourceId: 'board',
        title: 'Deliverable',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const file = path.join(
      root,
      '.mergeron-system',
      'livrables',
      'd',
      'file.txt',
    );
    database.db
      .insert(schema.projectDeliverableDocuments)
      .values({
        id: 'doc',
        deliverableId: 'd',
        name: 'file.txt',
        format: 'txt',
        sourcePath: file,
        currentVersionNumber: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const report = await service.inspect('p');
    expect(report.issues.some((i) => i.kind === 'document-missing')).toBe(true);
    expect(
      report.issues.some((i) => i.kind === 'current-version-missing'),
    ).toBe(true);
    expect(
      report.issues.find((i) => i.kind === 'directory-missing')?.action,
    ).toBeNull();
    await expect(fs.stat(file)).rejects.toThrow();
  });
  it('detects missing history and disables creating an empty history over registered versions', async () => {
    database.db
      .insert(schema.projectResources)
      .values({
        id: 'board',
        projectId: 'p',
        type: 'deliverable_board',
        name: 'Board',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(schema.projectDeliverables)
      .values({
        id: 'd',
        resourceId: 'board',
        title: 'Deliverable',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const folder = path.join(root, '.mergeron-system', 'livrables', 'd');
    await fs.mkdir(folder);
    const file = path.join(folder, 'file.txt');
    await fs.writeFile(file, 'keep');
    database.db
      .insert(schema.projectDeliverableDocuments)
      .values({
        id: 'doc',
        deliverableId: 'd',
        name: 'file.txt',
        format: 'txt',
        sourcePath: file,
        currentVersionNumber: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const history = path.join(root, '.mergeron-system', 'history');
    await fs.rmdir(history);
    database.db
      .insert(schema.projectDeliverableDocumentVersions)
      .values({
        id: 'version',
        documentId: 'doc',
        number: 1,
        fileName: 'file.txt',
        sourcePath: file,
        snapshotPath: path.join(history, 'version.txt'),
        size: 4,
        sha256: 'a'.repeat(64),
        authorName: 'Test',
        createdAt: 1,
      })
      .run();
    const report = await service.inspect('p');
    expect(
      report.issues.find(
        (i) => i.kind === 'directory-missing' && i.path === history,
      )?.action,
    ).toBeNull();
    expect(report.issues.some((i) => i.kind === 'snapshot-missing')).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('keep');
  });
  it('reports unregistered source directories without traversing Git contents', async () => {
    const copy = path.join(
      root,
      '.mergeron-system',
      'sources',
      'connection',
      'copies',
      'unknown',
    );
    await fs.mkdir(copy, { recursive: true });
    await fs.writeFile(path.join(copy, 'unpublished.txt'), 'keep');
    const report = await service.inspect('p');
    expect(report.issues.some((i) => i.kind === 'unregistered-copy')).toBe(
      true,
    );
    expect(
      report.issues.every((i) => !i.path.endsWith('unpublished.txt')),
    ).toBe(true);
  });
  it('marks a truncated inventory incomplete and disables corrections', async () => {
    const folder = path.join(root, '.mergeron-system', 'livrables');
    await Promise.all(
      Array.from({ length: 505 }, (_, i) =>
        fs.writeFile(path.join(folder, 'free-' + i), 'keep'),
      ),
    );
    const report = await service.inspect('p');
    expect(report.limited).toBe(true);
    expect(report.issues.some((i) => i.kind === 'scan-limited')).toBe(true);
    expect(report.issues.every((i) => !i.action)).toBe(true);
  });
  it('blocks all API routes for a standard or inactive account', () => {
    const controller = new ProjectIntegrityController(service);
    for (const identity of [
      { active: true, role: 'standard' },
      { active: false, role: 'administrator' },
      undefined,
    ]) {
      const request = { platformIdentity: identity } as IdentityRequest;
      expect(() => controller.list(request)).toThrow();
      expect(() => controller.inspect('p', request)).toThrow();
      expect(() => controller.repair('p', request, {})).toThrow();
      expect(() => controller.trashList('p', request)).toThrow();
      expect(() => controller.trash('p', request, {})).toThrow();
      expect(() => controller.recover('p', request, {})).toThrow();
    }
  });
  const orphan = async (name = 'orphan.txt') => {
    const file = path.join(root, '.mergeron-system', 'livrables', name);
    await fs.writeFile(file, 'unpublished useful data');
    const report = await service.inspect('p');
    const issue = report.issues.find((item) => item.path === file)!;
    return { file, report, issue };
  };
  const trashBody = (
    report: Awaited<ReturnType<ProjectIntegrityService['inspect']>>,
    issue: { id: string; path: string },
  ) => ({
    fingerprint: report.fingerprint,
    issueId: issue.id,
    name: path.basename(issue.path),
    confirmation: 'MOVE_TO_PROJECT_TRASH',
  });
  it('never offers removal for a broken connection or a limited report', async () => {
    missingReference();
    const report = await service.inspect('p');
    expect(
      report.issues.find(
        (item) => item.kind === 'active-folder-registration-missing',
      )?.trash,
    ).toBeUndefined();
  });
  it.skipIf(process.platform !== 'linux')(
    'moves only an explicitly named orphan to recoverable trash and recovers it without overwriting',
    async () => {
      const { file, report, issue } = await orphan();
      expect(issue.trash?.name).toBe('orphan.txt');
      await expect(
        service.trash(
          'p',
          { ...trashBody(report, issue), name: 'wrong' },
          actor,
        ),
      ).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8')).toBe('unpublished useful data');
      const next = await service.trash('p', trashBody(report, issue), actor);
      expect(next.issues.some((item) => item.path === file)).toBe(false);
      const { entries } = await service.trashList('p');
      expect(entries).toHaveLength(1);
      expect(entries[0].actorName).toBe(actor.name);
      // A new file occupies the old name: recovery must leave it untouched.
      await fs.writeFile(file, 'new original');
      const recovered = await service.recoverTrash(
        'p',
        { entryId: entries[0].id, confirmation: 'RECOVER_PROJECT_TRASH' },
        actor,
      );
      expect(
        recovered.path.startsWith(path.join(root, 'dossiers') + path.sep),
      ).toBe(true);
      expect(await fs.readFile(recovered.path, 'utf8')).toBe(
        'unpublished useful data',
      );
      expect(await fs.readFile(file, 'utf8')).toBe('new original');
      expect((await service.trashList('p')).entries).toHaveLength(0);
      expect(
        database.db
          .select()
          .from(schema.projectActivity)
          .all()
          .map((item) => item.action),
      ).toEqual(['integrity.trash', 'integrity.recover']);
    },
  );
  it.skipIf(process.platform !== 'linux')(
    'refuses a changed report and linked data',
    async () => {
      const { file, report, issue } = await orphan();
      await fs.writeFile(file, 'changed and longer');
      await expect(
        service.trash('p', trashBody(report, issue), actor),
      ).rejects.toThrow('changed');
      database.db
        .insert(schema.projectAgentThreads)
        .values({
          threadId: 'in-use',
          projectId: 'p',
          workspacePath: file,
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      const fresh = await service.inspect('p');
      expect(
        fresh.issues.find(
          (item) => item.path === file && item.kind === 'unregistered-document',
        )?.trash,
      ).toBeUndefined();
      await expect(
        service.trash('p', trashBody(fresh, issue), actor),
      ).rejects.toThrow('No removable');
      expect(await fs.readFile(file, 'utf8')).toBe('changed and longer');
    },
  );
  it.skipIf(process.platform !== 'linux')(
    'does not offer technical staging, hard links, or symlink trees for removal',
    async () => {
      const staging = path.join(
        root,
        '.mergeron-system',
        'livrables',
        '.version-staging',
      );
      await fs.mkdir(staging);
      await fs.writeFile(path.join(staging, 'pending.txt'), 'keep');
      const link = path.join(root, '.mergeron-system', 'livrables', 'linked');
      await fs.mkdir(link);
      await fs.symlink(parent, path.join(link, 'escape'));
      const { file } = await orphan('hard.txt');
      await fs.link(file, path.join(root, 'dossiers', 'other-link.txt'));
      const report = await service.inspect('p');
      expect(
        report.issues
          .filter(
            (item) =>
              item.path.includes('.version-staging') ||
              item.path === link ||
              item.path === file,
          )
          .every((item) => !item.trash),
      ).toBe(true);
    },
  );
  it.skipIf(process.platform !== 'linux')(
    'retains a pending recovery record if updating the journal after the move fails',
    async () => {
      const { report, issue } = await orphan();
      const spy = vi.spyOn(database.db, 'update').mockImplementation(() => {
        throw new Error('Synthetic journal failure');
      });
      try {
        await expect(
          service.trash('p', trashBody(report, issue), actor),
        ).rejects.toThrow('Synthetic journal failure');
      } finally {
        spy.mockRestore();
      }
      const { entries } = await service.trashList('p');
      expect(entries).toHaveLength(1);
      const recovered = await service.recoverTrash(
        'p',
        { entryId: entries[0].id, confirmation: 'RECOVER_PROJECT_TRASH' },
        actor,
      );
      expect(await fs.readFile(recovered.path, 'utf8')).toBe(
        'unpublished useful data',
      );
    },
  );
  it.skipIf(process.platform !== 'linux')(
    'retains a whole orphan directory and unpublished Git contents',
    async () => {
      const folder = path.join(
        root,
        '.mergeron-system',
        'sources',
        'unregistered-connection',
        'copies',
        'orphan-copy',
      );
      await fs.mkdir(path.join(folder, '.git'), { recursive: true });
      await fs.writeFile(path.join(folder, 'local.txt'), 'not pushed');
      const report = await service.inspect('p');
      const issue = report.issues.find(
        (item) => item.kind === 'unregistered-copy',
      )!;
      expect(issue.trash).toBeTruthy();
      await service.trash('p', trashBody(report, issue), actor);
      const { entries } = await service.trashList('p');
      const recovered = await service.recoverTrash(
        'p',
        { entryId: entries[0].id, confirmation: 'RECOVER_PROJECT_TRASH' },
        actor,
      );
      expect(
        await fs.readFile(path.join(recovered.path, 'local.txt'), 'utf8'),
      ).toBe('not pushed');
      expect(
        (await fs.stat(path.join(recovered.path, '.git'))).isDirectory(),
      ).toBe(true);
    },
  );
});
