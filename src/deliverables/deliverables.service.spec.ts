import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentPathAlias } from './document-path-alias';
import { Readable } from 'node:stream';
import { migrateDeliverableDocumentRoots } from './document-root-migration';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projects,
  projectResources,
  projectWorkspaces,
  projectAgentThreads,
  projectTasks,
  projectTaskStatuses,
  people,
  projectParticipants,
  projectPersonGroups,
  projectPersonGroupMembers,
} from '../database/schema';
import { DeliverablesService } from './deliverables.service';
import { FilesService } from '../files/files.service';
import type { SettingsService } from '../settings/settings.service';
import { SECURITY_SETTING_KEYS } from '../settings/settings.definitions';
import { ProjectsService } from '../projects/projects.service';
import { IdentityService } from '../auth/identity.service';
import { accessContext } from '../auth/access-context';
import { ActiveFoldersService } from '../active-folders/active-folders.service';

describe('project deliverables', () => {
  let database: TestDatabase,
    root: string,
    service: DeliverablesService,
    files: FilesService;
  beforeEach(async () => {
    database = createTestDatabase();
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'deliverables-')),
    );
    await fs.mkdir(path.join(root, '.mergeron'));
    const now = Date.now();
    database.db
      .insert(projects)
      .values({
        id: 'p',
        name: 'Project',
        workspacePath: root,
        workspaceLayoutVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectWorkspaces)
      .values({
        id: 'w',
        projectId: 'p',
        name: 'Primary',
        path: root,
        primary: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectResources)
      .values({
        id: 'r',
        projectId: 'p',
        name: 'Deliverables',
        type: 'deliverable_board',
        config: {},
        createdAt: now,
        updatedAt: now,
      })
      .run();
    files = new FilesService(
      {
        getStringSetting: (key: string) =>
          key === SECURITY_SETTING_KEYS.workspaceRoots ? root : '',
        getSetting: () => ({ value: '' }),
        onChange: () => () => {},
      } as unknown as SettingsService,
      database.db,
    );
    service = new DeliverablesService(
      database.db,
      files,
      new IdentityService(database.db),
      new ActiveFoldersService(database.db),
    );
  });
  it.each([false, true])(
    'synchronizes explorer create, upload, save, rename and recoverable delete (protected=%s)',
    async (protectedSource) => {
      vi.stubEnv(
        'MERGERON_PUBLISHED_DOCUMENT_PROTECTION',
        protectedSource ? 'required' : '',
      );
      try {
        const item = await service.create('p', 'r', { title: 'Explorer' });
        const source = path.join(root, 'livrables', item.id, 'report.txt');
        await files.createFile(source, 'First');
        let document = service.documents('p', 'r', item.id)[0];
        expect(document).toMatchObject({
          name: 'report.txt',
          currentVersionNumber: 1,
          sourcePath: source,
        });
        await files.writeFile(source, 'Second');
        document = service.documents('p', 'r', item.id)[0];
        expect(document.currentVersionNumber).toBe(2);
        const renamed = await files.renamePath(source, 'renamed.txt');
        document = service.documents('p', 'r', item.id)[0];
        expect(document.sourcePath).toBe(renamed.newPath);
        expect(documentPathAlias(database.db, source)).toBe(renamed.newPath);
        async function* uploads() {
          await Promise.resolve();
          yield { filename: 'renamed.txt', stream: Readable.from(['Third']) };
        }
        await service.uploadDocuments('p', 'r', item.id, uploads(), {
          documentId: document.id,
          expectedVersion: 2,
          comment: 'Uploaded',
        });
        document = service.documents('p', 'r', item.id)[0];
        expect(document.currentVersionNumber).toBe(3);
        expect(document.versions[0].comment).toBe('Uploaded');
        await files.deletePath(document.sourcePath);
        expect(
          service.documents('p', 'r', item.id)[0].deletedAt,
        ).not.toBeNull();
        expect(await files.readDirectory(path.dirname(source))).toEqual([]);
        expect(
          await fs.readFile(document.versions[2].snapshotPath, 'utf8'),
        ).toBe('First');
        service.setDocumentDeleted('p', 'r', item.id, document.id, 3, false);
        expect(
          (await files.readDirectory(path.dirname(source))).map(
            (file) => file.name,
          ),
        ).toEqual(['renamed.txt']);
        expect(await fs.readFile(document.sourcePath, 'utf8')).toBe('Third');
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
  it('guards explorer mutations and uploads before touching retained files', async () => {
    const item = await service.create('p', 'r', { title: 'Explorer guards' });
    const directory = path.join(root, 'livrables', item.id);
    const source = path.join(directory, 'report.txt');
    await files.createFile(source, 'Original');
    const document = service.documents('p', 'r', item.id)[0];
    async function* uploads() {
      await Promise.resolve();
      yield { filename: 'report.txt', stream: Readable.from(['Replacement']) };
    }
    await expect(
      service.uploadDocuments('p', 'r', item.id, uploads(), {
        documentId: document.id,
        expectedVersion: 5,
      }),
    ).rejects.toThrow('Reload');
    await expect(files.deletePath(directory, true)).rejects.toThrow();
    const importDirectory = path.join(root, 'incoming');
    await fs.mkdir(importDirectory);
    await expect(
      files.copyPath(importDirectory, path.join(root, 'livrables'), true),
    ).rejects.toThrow();
    await expect(
      files.movePath(source, path.join(root, 'moved.txt')),
    ).rejects.toThrow();
    await expect(
      files.saveUploadedFiles(directory, uploads(), true),
    ).resolves.toMatchObject({ files: [{ path: source }] });
    service.updateOnlyOfficeSession(source, 'editing');
    await expect(files.writeFile(source, 'Blocked')).rejects.toThrow('Close');
    expect(() =>
      service.setDocumentDeleted('p', 'r', item.id, document.id, 2, true),
    ).toThrow('Close');
    service.updateOnlyOfficeSession(source, 'saved');
    const current = service.get('p', 'r', item.id);
    service.transitionLifecycle('p', 'r', item.id, {
      target: 'finalized',
      version: current.version,
    });
    await expect(
      files.createFile(path.join(directory, 'new.txt'), 'Blocked'),
    ).rejects.toThrow('Reopen');
    await expect(files.renamePath(source, 'new.txt')).rejects.toThrow('Reopen');
    await expect(files.deletePath(source)).rejects.toThrow('Reopen');
    await expect(
      files.saveUploadedFiles(directory, uploads(), true),
    ).rejects.toThrow('Reopen');
    expect(await fs.readFile(source, 'utf8')).toBe('Replacement');
    expect(service.documents('p', 'r', item.id)[0].currentVersionNumber).toBe(
      2,
    );
  });
  it.each([false, true])(
    'renames a document without losing versions, content or old links (protected=%s)',
    async (protectedSource) => {
      vi.stubEnv(
        'MERGERON_PUBLISHED_DOCUMENT_PROTECTION',
        protectedSource ? 'required' : '',
      );
      try {
        const item = await service.create('p', 'r', { title: 'Rename' });
        const source = path.join(root, 'livrables', item.id, 'report.docx');
        await fs.writeFile(source, 'Version one');
        await service.addDocumentVersion(
          'p',
          'r',
          item.id,
          { path: source },
          { personId: null, name: 'Alice' },
        );
        const document = service.documents('p', 'r', item.id)[0];
        const renamed = await service.renameDocument(
          'p',
          'r',
          item.id,
          document.id,
          {
            name: 'Renamed.docx',
            expectedName: document.name,
            expectedVersion: 1,
          },
        );
        expect(renamed.previousFileRetained).toBe(false);
        const current = service.documents('p', 'r', item.id)[0];
        expect(current).toMatchObject({
          id: document.id,
          name: 'Renamed.docx',
          currentVersionNumber: 1,
          format: 'docx',
        });
        expect(current.versions).toEqual(document.versions);
        expect(await fs.readFile(current.sourcePath, 'utf8')).toBe(
          'Version one',
        );
        expect(documentPathAlias(database.db, document.sourcePath)).toBe(
          current.sourcePath,
        );
        await expect(fs.stat(document.sourcePath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await fs.writeFile(current.sourcePath, 'Version two');
        await service.addDocumentVersion(
          'p',
          'r',
          item.id,
          { path: current.sourcePath, expectedVersion: 1 },
          { personId: null, name: 'Bob' },
          current.id,
        );
        await service.restoreDocumentVersion(
          'p',
          'r',
          item.id,
          current.id,
          document.versions[0].id,
          { expectedVersion: 2 },
          { personId: null, name: 'Alice' },
        );
        expect(await fs.readFile(current.sourcePath, 'utf8')).toBe(
          'Version one',
        );
        expect(service.documents('p', 'r', item.id)[0].versions).toHaveLength(
          3,
        );
        expect(
          await fs.readFile(document.versions[0].snapshotPath, 'utf8'),
        ).toBe('Version one');
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
  it('retains unregistered files before explorer removal and rolls back failed version writes', async () => {
    const item = await service.create('p', 'r', { title: 'Explorer recovery' });
    const source = path.join(root, 'livrables', item.id, 'legacy.txt');
    await fs.writeFile(source, 'Legacy content');
    await files.deletePath(source);
    const removed = service.documents('p', 'r', item.id)[0];
    expect(removed.deletedAt).not.toBeNull();
    expect(await fs.readFile(removed.versions[0].snapshotPath, 'utf8')).toBe(
      'Legacy content',
    );
    service.setDocumentDeleted('p', 'r', item.id, removed.id, 1, false);
    const transaction = vi
      .spyOn(database.db, 'transaction')
      .mockImplementationOnce(() => {
        throw new Error('commit failed');
      });
    try {
      await expect(files.writeFile(source, 'Failed version')).rejects.toThrow(
        'commit failed',
      );
    } finally {
      transaction.mockRestore();
    }
    expect(await fs.readFile(source, 'utf8')).toBe('Legacy content');
    expect(service.documents('p', 'r', item.id)[0].currentVersionNumber).toBe(
      1,
    );
    expect(
      await fs.readdir(path.join(root, 'livrables', '.version-staging')),
    ).toEqual([]);
  });
  it('rejects conflicting names, unsafe names, stale requests and active editors without changing the original', async () => {
    const item = await service.create('p', 'r', { title: 'Rename guards' });
    const source = path.join(root, 'livrables', item.id, 'report.docx');
    await fs.writeFile(source, 'Original');
    await service.addDocumentVersion(
      'p',
      'r',
      item.id,
      { path: source },
      { personId: null, name: 'Alice' },
    );
    const document = service.documents('p', 'r', item.id)[0];
    const input = {
      name: 'new.docx',
      expectedName: document.name,
      expectedVersion: 1,
    };
    for (const name of [
      '../bad.docx',
      'x/y.docx',
      'x\\y.docx',
      '',
      'changed.pdf',
    ])
      await expect(
        service.renameDocument('p', 'r', item.id, document.id, {
          ...input,
          name,
        }),
      ).rejects.toThrow();
    await expect(
      service.renameDocument('p', 'r', item.id, document.id, {
        ...input,
        expectedVersion: 2,
      }),
    ).rejects.toThrow('Reload');
    await fs.writeFile(
      path.join(path.dirname(document.sourcePath), 'new.docx'),
      'Other file',
    );
    await expect(
      service.renameDocument('p', 'r', item.id, document.id, input),
    ).rejects.toThrow('already exists');
    service.updateOnlyOfficeSession(document.sourcePath, 'editing');
    await expect(
      service.renameDocument('p', 'r', item.id, document.id, {
        ...input,
        name: 'free.docx',
      }),
    ).rejects.toThrow('Close the document editor');
    expect(await fs.readFile(document.sourcePath, 'utf8')).toBe('Original');
    expect(service.documents('p', 'r', item.id)[0].name).toBe('report.docx');
  });
  it('rejects a symlink substituted for the registered document', async () => {
    const item = await service.create('p', 'r', { title: 'Rename symlink' });
    const source = path.join(root, 'livrables', item.id, 'report.docx');
    await fs.writeFile(source, 'Original');
    await service.addDocumentVersion(
      'p',
      'r',
      item.id,
      { path: source },
      { personId: null, name: 'Alice' },
    );
    const document = service.documents('p', 'r', item.id)[0];
    const other = path.join(path.dirname(source), 'other.docx');
    await fs.writeFile(other, 'Unrelated');
    await fs.unlink(document.sourcePath);
    await fs.symlink(other, document.sourcePath);
    await expect(
      service.renameDocument('p', 'r', item.id, document.id, {
        name: 'new.docx',
        expectedName: document.name,
        expectedVersion: 1,
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(other, 'utf8')).toBe('Unrelated');
    expect(service.documents('p', 'r', item.id)[0].sourcePath).toBe(
      document.sourcePath,
    );
    await expect(
      fs.stat(path.join(path.dirname(source), 'new.docx')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('serializes concurrent renames and rejects the stale name', async () => {
    const item = await service.create('p', 'r', {
      title: 'Rename concurrency',
    });
    const source = path.join(root, 'livrables', item.id, 'report.docx');
    await fs.writeFile(source, 'Original');
    await service.addDocumentVersion(
      'p',
      'r',
      item.id,
      { path: source },
      { personId: null, name: 'Alice' },
    );
    const document = service.documents('p', 'r', item.id)[0];
    const results = await Promise.allSettled(
      ['first.docx', 'second.docx'].map((name) =>
        service.renameDocument('p', 'r', item.id, document.id, {
          name,
          expectedName: document.name,
          expectedVersion: 1,
        }),
      ),
    );
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const current = service.documents('p', 'r', item.id)[0];
    expect(current.name).toBe('first.docx');
    expect(await fs.readFile(current.sourcePath, 'utf8')).toBe('Original');
    expect(current.versions).toEqual(document.versions);
  });
  it('keeps renamed paths reserved and safely finishes interrupted cleanup on restart', async () => {
    const item = await service.create('p', 'r', { title: 'Rename recovery' });
    const source = path.join(root, 'livrables', item.id, 'report.docx');
    await fs.writeFile(source, 'Original');
    await service.addDocumentVersion(
      'p',
      'r',
      item.id,
      { path: source },
      { personId: null, name: 'Alice' },
    );
    const document = service.documents('p', 'r', item.id)[0];
    const renamed = await service.renameDocument(
      'p',
      'r',
      item.id,
      document.id,
      {
        name: 'new.docx',
        expectedName: document.name,
        expectedVersion: 1,
      },
    );
    await fs.copyFile(renamed.newPath, source);
    const warn = vi.fn();
    await migrateDeliverableDocumentRoots(database.db, warn);
    expect(warn).not.toHaveBeenCalled();
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(renamed.newPath, 'utf8')).toBe('Original');
    expect(await fs.readFile(document.versions[0].snapshotPath, 'utf8')).toBe(
      'Original',
    );
    const second = path.join(root, 'livrables', item.id, 'second.docx');
    await fs.writeFile(second, 'Second');
    await service.addDocumentVersion(
      'p',
      'r',
      item.id,
      { path: second },
      { personId: null, name: 'Alice' },
    );
    const other = service
      .documents('p', 'r', item.id)
      .find((entry) => entry.id !== document.id)!;
    await expect(
      service.renameDocument('p', 'r', item.id, other.id, {
        name: 'report.docx',
        expectedName: other.name,
        expectedVersion: 1,
      }),
    ).rejects.toThrow('reserves this name');
    expect(documentPathAlias(database.db, source)).toBe(renamed.newPath);
    const ready = service.get('p', 'r', item.id);
    service.transitionLifecycle('p', 'r', item.id, {
      target: 'finalized',
      version: ready.version,
    });
    await expect(
      service.renameDocument('p', 'r', item.id, other.id, {
        name: 'finalized.docx',
        expectedName: other.name,
        expectedVersion: 1,
      }),
    ).rejects.toThrow('Reopen the deliverable');
  });
  it('preserves the original when the rename database commit fails', async () => {
    const item = await service.create('p', 'r', { title: 'Rename rollback' });
    const source = path.join(root, 'livrables', item.id, 'report.docx');
    await fs.writeFile(source, 'Original');
    await service.addDocumentVersion(
      'p',
      'r',
      item.id,
      { path: source },
      { personId: null, name: 'Alice' },
    );
    const document = service.documents('p', 'r', item.id)[0];
    const transaction = vi
      .spyOn(database.db, 'transaction')
      .mockImplementationOnce(() => {
        throw new Error('commit failed');
      });
    try {
      await expect(
        service.renameDocument('p', 'r', item.id, document.id, {
          name: 'new.docx',
          expectedName: document.name,
          expectedVersion: 1,
        }),
      ).rejects.toThrow('commit failed');
    } finally {
      transaction.mockRestore();
    }
    expect(await fs.readFile(document.sourcePath, 'utf8')).toBe('Original');
    await expect(
      fs.stat(path.join(path.dirname(document.sourcePath), 'new.docx')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(service.documents('p', 'r', item.id)[0].sourcePath).toBe(
      document.sourcePath,
    );
  });
  it('records creator and last editor when saving a deliverable', async () => {
    const item = await service.create('p', 'r', { title: 'Audit' });
    expect(item.createdByName).toBe('System');
    expect(item.updatedByName).toBe('System');
    const updated = service.update('p', 'r', item.id, {
      title: 'Updated audit',
      version: item.version,
    });
    expect(updated.createdByName).toBe(item.createdByName);
    expect(updated.updatedByName).toBe('System');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(item.createdAt);
    expect(service.board('p', 'r').deliverables[0].activityEvents).toEqual([
      expect.objectContaining({
        action: 'deliverable_updated',
        actorName: 'System',
        details: { fields: ['title'] },
      }),
    ]);
    expect(() =>
      service.update('p', 'r', item.id, {
        title: 'Stale',
        version: item.version,
      }),
    ).toThrow('Reload');
    expect(service.board('p', 'r').deliverables[0].activityEvents).toHaveLength(
      1,
    );
    const required = service.setValidationRequirement(
      'p',
      'r',
      item.id,
      { required: true, version: updated.version },
      { personId: null, name: 'Bob' },
    );
    expect(required.createdByName).toBe('System');
    expect(required.updatedByName).toBe('Bob');
  });
  it('retains document deletion and restoration events across repeated cycles', async () => {
    const item = await service.create('p', 'r', { title: 'Audited documents' });
    const source = path.join(root, 'livrables', item.id, 'report.docx');
    await fs.writeFile(source, 'Report');
    const created = await service.addDocumentVersion(
      'p',
      'r',
      item.id,
      { path: source },
      { personId: null, name: 'Alice' },
    );
    service.setDocumentDeleted('p', 'r', item.id, created.document.id, 1, true);
    service.setDocumentDeleted('p', 'r', item.id, created.document.id, 1, true);
    service.setDocumentDeleted(
      'p',
      'r',
      item.id,
      created.document.id,
      1,
      false,
    );
    service.setDocumentDeleted('p', 'r', item.id, created.document.id, 1, true);
    const result = service.board('p', 'r').deliverables[0];
    expect(
      result.activityEvents.filter(
        (event) => event.action === 'deliverable_document_deleted',
      ),
    ).toHaveLength(2);
    expect(
      result.activityEvents.filter(
        (event) => event.action === 'deliverable_document_restored',
      ),
    ).toHaveLength(1);
    expect(
      result.activityEvents.every(
        (event) => event.details.documentId === created.document.id,
      ),
    ).toBe(true);
    expect(result.documents[0].versions[0].authorName).toBe('Alice');
    const projectsService = new ProjectsService(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      database.db,
    );
    expect(
      projectsService
        .activity('p')
        .some((event) => event.entityType === 'deliverable_history'),
    ).toBe(false);
    expect(await fs.readFile(source, 'utf8')).toBe('Report');
    const other = await service.create('p', 'r', { title: 'Unrelated' });
    expect(
      service
        .board('p', 'r')
        .deliverables.find((entry) => entry.id === other.id)?.activityEvents,
    ).toEqual([]);
  });
  it('associates one main task from the project and clears it when the task is deleted', async () => {
    const now = Date.now();
    database.db
      .insert(projectResources)
      .values({
        id: 'tasks',
        projectId: 'p',
        name: 'Tasks',
        type: 'task_board',
        config: {},
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectTaskStatuses)
      .values({
        id: 'todo',
        resourceId: 'tasks',
        name: 'To do',
        color: 'slate',
        kind: 'unassigned',
        position: 0,
        system: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectTasks)
      .values({
        id: 'main-task',
        resourceId: 'tasks',
        statusId: 'todo',
        title: 'Main task',
        position: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const item = await service.create('p', 'r', {
      title: 'Linked',
      primaryTaskId: 'main-task',
    });
    expect(item.primaryTaskId).toBe('main-task');
    expect(service.board('p', 'r').tasks[0]).toMatchObject({
      id: 'main-task',
      status: 'To do',
      parentTaskId: null,
    });
    expect(service.board('p', 'r').taskManagers).toEqual([
      { id: 'tasks', name: 'Tasks' },
    ]);
    database.db
      .delete(projectTasks)
      .where(eq(projectTasks.id, 'main-task'))
      .run();
    expect(service.get('p', 'r', item.id).primaryTaskId).toBeNull();
  });
  it('limits restricted deliverables to authorized group members and administrators', async () => {
    const now = Date.now();
    const identities = new IdentityService(database.db);
    for (const id of ['alice', 'bob']) {
      database.db
        .insert(people)
        .values({
          id,
          reference: id,
          name: id,
          email: `${id}@example.com`,
          identitySubject: id,
          role: 'standard',
          active: true,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      database.db
        .insert(projectParticipants)
        .values({ projectId: 'p', personId: id, createdAt: now })
        .run();
    }
    database.db
      .insert(projectPersonGroups)
      .values({
        id: 'reviewers',
        projectId: 'p',
        name: 'Reviewers',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectPersonGroupMembers)
      .values({ groupId: 'reviewers', personId: 'alice', createdAt: now })
      .run();
    const item = await service.create('p', 'r', {
      title: 'Restricted',
      confidentiality: 'restricted',
      authorizedGroupIds: ['reviewers'],
    });
    const identity = (id: string) => ({
      kind: 'person' as const,
      personId: id,
      name: id,
      role: 'standard' as const,
      active: true,
    });
    const asPerson = <T>(id: string, action: () => T) =>
      accessContext.run({ identity: identity(id), identities }, action);
    expect(
      asPerson('alice', () => service.board('p', 'r').deliverables),
    ).toHaveLength(1);
    expect(
      asPerson('bob', () => service.board('p', 'r').deliverables),
    ).toHaveLength(0);
    expect(() => asPerson('bob', () => service.get('p', 'r', item.id))).toThrow(
      'not found',
    );
    expect(
      accessContext.run(
        {
          identity: { ...identity('bob'), role: 'administrator' as const },
          identities,
        },
        () => service.get('p', 'r', item.id),
      ).id,
    ).toBe(item.id);
    await expect(
      service.create('p', 'r', {
        title: 'Invalid',
        confidentiality: 'restricted',
        authorizedGroupIds: [],
      }),
    ).rejects.toThrow('requires at least one group');
  });
  afterEach(async () => {
    database.sqlite.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  it('preserves validated snapshots while a later version is prepared and leaves files on removal', async () => {
    const item = await service.create('p', 'r', {
      title: 'Report',
      criteria: 'Readable',
    });
    const source = path.join(root, 'livrables', item.id, 'report.txt');
    await fs.writeFile(source, 'First');
    const first = await service.submit('p', 'r', item.id, {
      paths: [source],
      version: 1,
    });
    expect(first.status).toBe('proposed');
    await fs.writeFile(source, 'Next');
    expect(
      await fs.readFile(
        (await service.file('p', 'r', item.id, first.id, 0)).snapshotPath,
        'utf8',
      ),
    ).toBe('First');
    await service.review(
      'p',
      'r',
      item.id,
      first.id,
      { action: 'validate', version: 2 },
      'Alice',
    );
    const second = await service.submit('p', 'r', item.id, {
      paths: [source],
      version: 3,
    });
    expect(service.get('p', 'r', item.id).validatedVersionId).toBe(first.id);
    expect(second.number).toBe(2);
    expect(() =>
      service.update('p', 'r', item.id, { title: 'Stale', version: 1 }),
    ).toThrow('Reload');
    service.remove('p', 'r', item.id, 4);
    expect(await fs.readFile(first.files[0].snapshotPath, 'utf8')).toBe(
      'First',
    );
    expect(await fs.readFile(source, 'utf8')).toBe('Next');
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
  it('versions every document independently and restores history as a new version', async () => {
    const item = await service.create('p', 'r', { title: 'Document set' });
    const report = path.join(root, 'livrables', item.id, 'report.docx');
    const sheet = path.join(root, 'livrables', item.id, 'budget.xlsx');
    await fs.writeFile(report, 'Report V1');
    await service.addDocumentVersion(
      'p',
      'r',
      item.id,
      { path: report, comment: 'Initial report' },
      { personId: null, name: 'Alice' },
    );
    await fs.writeFile(sheet, 'Budget V1');
    await service.addDocumentVersion(
      'p',
      'r',
      item.id,
      { path: sheet },
      { personId: null, name: 'Bob' },
    );
    let documents = service.documents('p', 'r', item.id);
    const reportDocument = documents.find(
      (document) => document.name === 'report.docx',
    )!;
    const sheetDocument = documents.find(
      (document) => document.name === 'budget.xlsx',
    )!;
    expect(reportDocument.currentVersionNumber).toBe(1);
    expect(sheetDocument.currentVersionNumber).toBe(1);
    expect(reportDocument.versions[0].authorName).toBe('Alice');

    await fs.writeFile(report, 'Report V2');
    await service.addDocumentVersion(
      'p',
      'r',
      item.id,
      { path: report, expectedVersion: 1, comment: 'Reworked' },
      { personId: null, name: 'Alice' },
      reportDocument.id,
    );
    documents = service.documents('p', 'r', item.id);
    expect(
      documents.find((document) => document.id === reportDocument.id)?.versions,
    ).toHaveLength(2);
    expect(
      documents.find((document) => document.id === sheetDocument.id)?.versions,
    ).toHaveLength(1);
    await expect(
      service.addDocumentVersion(
        'p',
        'r',
        item.id,
        { path: report, expectedVersion: 2 },
        { personId: null, name: 'Alice' },
        reportDocument.id,
      ),
    ).rejects.toThrow('has not changed');

    const firstVersion = documents
      .find((document) => document.id === reportDocument.id)!
      .versions.find((version) => version.number === 1)!;
    await service.restoreDocumentVersion(
      'p',
      'r',
      item.id,
      reportDocument.id,
      firstVersion.id,
      { expectedVersion: 2 },
      { personId: null, name: 'Alice' },
    );
    expect(await fs.readFile(report, 'utf8')).toBe('Report V1');
    expect(
      service
        .documents('p', 'r', item.id)
        .find((document) => document.id === reportDocument.id),
    ).toMatchObject({ currentVersionNumber: 3, deletedAt: null });
    service.setDocumentDeleted('p', 'r', item.id, reportDocument.id, 3, true);
    expect(
      service
        .documents('p', 'r', item.id)
        .find((document) => document.id === reportDocument.id)?.deletedAt,
    ).toEqual(expect.any(Number));
    service.setDocumentDeleted('p', 'r', item.id, reportDocument.id, 3, false);
    expect(
      service
        .documents('p', 'r', item.id)
        .find((document) => document.id === reportDocument.id)?.deletedAt,
    ).toBeNull();
  });
  it('validates an immutable snapshot and marks pending requests outdated after document changes', async () => {
    const item = await service.create('p', 'r', { title: 'Approval pack' });
    const source = path.join(root, 'livrables', item.id, 'report.docx');
    await fs.writeFile(source, 'Version 1');
    await service.addDocumentVersion(
      'p',
      'r',
      item.id,
      { path: source },
      { personId: null, name: 'Alice' },
    );
    service.setValidationRequirement(
      'p',
      'r',
      item.id,
      { required: true, version: 2 },
      { personId: null, name: 'Alice' },
    );
    service.transitionLifecycle('p', 'r', item.id, {
      target: 'finalized',
      version: 3,
    });
    const firstRequest = service.requestValidation(
      'p',
      'r',
      item.id,
      { version: 4 },
      { personId: null, name: 'Alice' },
    );
    expect(
      service.board('p', 'r').deliverables[0].validations[0],
    ).toMatchObject({ id: firstRequest.id, effectiveStatus: 'pending' });

    const document = service.documents('p', 'r', item.id)[0];
    service.transitionLifecycle('p', 'r', item.id, {
      target: 'in_constitution',
      version: 5,
    });
    await fs.writeFile(source, 'Version 2');
    await service.addDocumentVersion(
      'p',
      'r',
      item.id,
      { path: source, expectedVersion: 1 },
      { personId: null, name: 'Alice' },
      document.id,
    );
    expect(
      service.board('p', 'r').deliverables[0].validations[0].effectiveStatus,
    ).toBe('outdated');
    expect(service.board('p', 'r').deliverables[0].validationStatus).toBe(
      'outdated',
    );
    expect(() =>
      service.decideValidation(
        'p',
        'r',
        item.id,
        firstRequest.id,
        { action: 'approve', version: 7 },
        { personId: null, name: 'Bob' },
      ),
    ).toThrow('outdated');

    service.transitionLifecycle('p', 'r', item.id, {
      target: 'finalized',
      version: 7,
    });
    const secondRequest = service.requestValidation(
      'p',
      'r',
      item.id,
      { version: 8 },
      { personId: null, name: 'Alice' },
    );
    expect(() =>
      service.decideValidation(
        'p',
        'r',
        item.id,
        secondRequest.id,
        { action: 'reject', version: 9 },
        { personId: null, name: 'Bob' },
      ),
    ).toThrow('reason');
    const decision = service.decideValidation(
      'p',
      'r',
      item.id,
      secondRequest.id,
      { action: 'approve', comment: 'Conforme', version: 9 },
      { personId: null, name: 'Bob' },
    );
    expect(decision).toMatchObject({
      status: 'approved',
      decidedByName: 'Bob',
      decisionComment: 'Conforme',
    });
    expect(service.get('p', 'r', item.id).status).toBe('validated');
    const approved = service.board('p', 'r').deliverables[0];
    expect(approved).toMatchObject({
      validationRequired: true,
      validationStatus: 'approved',
    });
    expect(approved.lastApprovedSnapshotId).toEqual(expect.any(String));
  });
  it('cancels an active request before validation can be disabled', async () => {
    const item = await service.create('p', 'r', { title: 'Optional review' });
    const source = path.join(root, 'livrables', item.id, 'report.docx');
    await fs.writeFile(source, 'Version 1');
    await service.addDocumentVersion(
      'p',
      'r',
      item.id,
      { path: source },
      { personId: null, name: 'Alice' },
    );
    service.setValidationRequirement(
      'p',
      'r',
      item.id,
      { required: true, version: 2 },
      { personId: null, name: 'Alice' },
    );
    service.transitionLifecycle('p', 'r', item.id, {
      target: 'finalized',
      version: 3,
    });
    const request = service.requestValidation(
      'p',
      'r',
      item.id,
      { version: 4 },
      { personId: null, name: 'Alice' },
    );
    expect(() =>
      service.setValidationRequirement(
        'p',
        'r',
        item.id,
        { required: false, reason: 'Plus nécessaire', version: 5 },
        { personId: null, name: 'Alice' },
      ),
    ).toThrow('Cancel the pending');
    service.cancelValidation(
      'p',
      'r',
      item.id,
      request.id,
      { reason: 'Périmètre réduit', version: 5 },
      { personId: null, name: 'Alice' },
    );
    service.setValidationRequirement(
      'p',
      'r',
      item.id,
      { required: false, reason: 'Plus nécessaire', version: 6 },
      { personId: null, name: 'Alice' },
    );
    const disabled = service.board('p', 'r').deliverables[0];
    expect(disabled).toMatchObject({
      validationRequired: false,
      validationStatus: 'not_required',
    });
    expect(disabled.validations.map((entry) => entry.status)).toContain(
      'cancelled',
    );
    expect(disabled.validationEvents.map((event) => event.action)).toEqual(
      expect.arrayContaining(['disabled', 'cancelled', 'enabled']),
    );
  });
  it('enforces the deliverable lifecycle and preserves immutable finalization snapshots', async () => {
    const item = await service.create('p', 'r', { title: 'Lifecycle' });
    expect(item.lifecycleStatus).toBe('draft');
    expect(() =>
      service.transitionLifecycle('p', 'r', item.id, {
        target: 'finalized',
        version: 1,
      }),
    ).toThrow('at least one document');

    const source = path.join(root, 'livrables', item.id, 'report.docx');
    await fs.writeFile(source, 'Version 1');
    await service.addDocumentVersion(
      'p',
      'r',
      item.id,
      { path: source },
      { personId: null, name: 'Alice' },
    );
    expect(service.get('p', 'r', item.id)).toMatchObject({
      lifecycleStatus: 'in_constitution',
      version: 2,
    });
    const linkedSource = service.board('p', 'r').deliverables[0].documents[0]
      .sourcePath;
    expect(service.onlyOfficeAccess(linkedSource)).toMatchObject({
      editable: true,
    });

    service.updateOnlyOfficeSession(linkedSource, 'editing');
    expect(() =>
      service.transitionLifecycle('p', 'r', item.id, {
        target: 'finalized',
        version: 2,
      }),
    ).toThrow('close their editors');
    service.updateOnlyOfficeSession(linkedSource, 'saved');

    const finalized = service.transitionLifecycle('p', 'r', item.id, {
      target: 'finalized',
      version: 2,
    });
    expect(finalized).toMatchObject({
      lifecycleStatus: 'finalized',
      version: 3,
      finalizedByName: 'System',
    });
    expect(finalized.currentSnapshotId).toEqual(expect.any(String));
    expect(service.onlyOfficeAccess(linkedSource)).toMatchObject({
      editable: false,
    });
    const board = service.board('p', 'r').deliverables[0];
    expect(board.snapshots).toHaveLength(1);
    expect(board.snapshots[0].documents).toEqual([
      expect.objectContaining({ versionNumber: 1 }),
    ]);

    await fs.writeFile(source, 'Version 2');
    await expect(
      service.addDocumentVersion(
        'p',
        'r',
        item.id,
        { path: source, expectedVersion: 1 },
        { personId: null, name: 'Alice' },
        board.documents[0].id,
      ),
    ).rejects.toThrow('Reopen');

    const archived = service.transitionLifecycle('p', 'r', item.id, {
      target: 'archived',
      version: 3,
    });
    expect(archived.lifecycleStatus).toBe('archived');
    expect(() =>
      service.update('p', 'r', item.id, { title: 'Forbidden', version: 4 }),
    ).toThrow('read-only');
    expect(() =>
      service.transitionLifecycle('p', 'r', item.id, {
        target: 'in_constitution',
        version: 4,
      }),
    ).toThrow('Invalid deliverable lifecycle transition');

    const unarchived = service.transitionLifecycle('p', 'r', item.id, {
      target: 'finalized',
      version: 4,
    });
    const reopened = service.transitionLifecycle('p', 'r', item.id, {
      target: 'in_constitution',
      version: unarchived.version,
    });
    expect(reopened.lifecycleStatus).toBe('in_constitution');
    expect(
      service.board('p', 'r').deliverables[0].lifecycleEvents,
    ).toHaveLength(6);
  });
  it('rejects forged validation, out-of-project links, system files and tampered snapshots', async () => {
    await expect(
      service.create('p', 'r', { title: 'Forged', status: 'validated' }),
    ).rejects.toThrow('Validate a submitted');
    await expect(
      service.create('p', 'r', { title: 'Other', taskIds: ['foreign'] }),
    ).rejects.toThrow('belong to this project');
    await expect(
      service.create('p', 'r', { title: 'Other', assigneeId: 'foreign' }),
    ).rejects.toThrow('active project participant');
    const item = await service.create('p', 'r', { title: 'Output' });
    const secret = path.join(root, '.mergeron', 'secret.txt');
    await fs.writeFile(secret, 'Secret');
    await expect(
      service.submit('p', 'r', item.id, { paths: [secret], version: 1 }),
    ).rejects.toThrow();
    const source = path.join(root, 'file.txt');
    await fs.writeFile(source, 'Original');
    const version = await service.submit('p', 'r', item.id, {
      paths: [source],
      version: 1,
    });
    await fs.writeFile(version.files[0].snapshotPath, 'Tampered');
    await expect(
      service.review(
        'p',
        'r',
        item.id,
        version.id,
        { action: 'validate', version: 2 },
        'Bob',
      ),
    ).rejects.toThrow('modified');
    expect(service.get('p', 'r', item.id).validatedVersionId).toBeNull();
    await expect(
      service.file('p', 'r', item.id, version.id, 0),
    ).rejects.toThrow('modified');
    expect(() => service.get('other', 'r', item.id)).toThrow('not found');
  });
  it('injects the brief only into linked project conversations', async () => {
    const now = Date.now();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'agent',
        projectId: 'p',
        workspacePath: root,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const item = await service.create('p', 'r', {
      title: 'My brief',
      criteria: 'Checked',
      conversations: [{ type: 'agent', id: 'agent' }],
    });
    expect(service.contextForConversation('agent')).toContain('My brief');
    expect(service.contextForConversation('agent')).toContain(
      path.join(root, 'livrables', item.id),
    );
    expect(service.contextForConversation('unrelated')).toBeNull();
    const updated = service.update('p', 'r', item.id, {
      title: 'Renamed',
      version: 1,
    });
    expect(service.board('p', 'r').deliverables[0].directory).toBe(
      path.join(root, 'livrables', updated.id),
    );
  });
  it('returns existing optional managers and enforces singleton inserts in SQLite', () => {
    const projectsService = new ProjectsService(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      database.db,
    );
    expect(
      projectsService.createResource('p', { type: 'deliverable_board' }).id,
    ).toBe('r');
    const first = projectsService.createResource('p', {
      type: 'automation_board',
    });
    expect(
      projectsService.createResource('p', { type: 'automation_board' }).id,
    ).toBe(first.id);
    expect(() =>
      database.db
        .insert(projectResources)
        .values({
          id: 'duplicate',
          projectId: 'p',
          name: 'Duplicate',
          type: 'automation_board',
          config: {},
          createdAt: 1,
          updatedAt: 1,
        })
        .run(),
    ).toThrow('single_project_manager');
    expect(database.db.select().from(projectResources).all()).toHaveLength(2);
  });
  it('installs singleton constraints over legacy duplicates without deleting their content', async () => {
    database.sqlite.exec(
      'DROP TRIGGER single_project_manager_insert; DROP TRIGGER single_project_manager_move;',
    );
    for (const id of ['legacy-a', 'legacy-b'])
      database.db
        .insert(projectResources)
        .values({
          id,
          projectId: 'p',
          type: 'automation_board',
          name: id,
          config: { automations: [{ id }] },
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
    const migration = await fs.readFile(
      path.join(process.cwd(), 'drizzle/0032_project_deliverables.sql'),
      'utf8',
    );
    database.sqlite.exec(
      migration
        .slice(migration.indexOf('CREATE TRIGGER'))
        .replaceAll('--> statement-breakpoint', ''),
    );
    const legacy = database.db
      .select()
      .from(projectResources)
      .all()
      .filter((r) => r.type === 'automation_board');
    expect(legacy).toHaveLength(2);
    expect(legacy[1].config).toEqual({ automations: [{ id: 'legacy-b' }] });
    expect(() =>
      database.sqlite
        .prepare(
          "INSERT INTO project_resources (id,project_id,type,name,config,created_at,updated_at) VALUES ('third','p','automation_board','Third','{}',1,1)",
        )
        .run(),
    ).toThrow('single_project_manager');
    expect(() =>
      database.sqlite
        .prepare(
          "UPDATE project_resources SET name='Renamed' WHERE id='legacy-a'",
        )
        .run(),
    ).not.toThrow();
  });
  it('rejects symlink escapes and paths outside attached project workspaces', async () => {
    const item = await service.create('p', 'r', { title: 'Output' });
    const foreign = await fs.mkdtemp(
      path.join(os.tmpdir(), 'foreign-deliverables-'),
    );
    try {
      const source = path.join(foreign, 'file.txt');
      await fs.writeFile(source, 'Foreign');
      await fs.symlink(source, path.join(root, 'escape.txt'));
      await expect(
        service.submit('p', 'r', item.id, { paths: [source], version: 1 }),
      ).rejects.toThrow();
      await expect(
        service.submit('p', 'r', item.id, {
          paths: [path.join(root, 'escape.txt')],
          version: 1,
        }),
      ).rejects.toThrow();
      expect(service.get('p', 'r', item.id).version).toBe(1);
    } finally {
      await fs.rm(foreign, { recursive: true, force: true });
    }
  });
  it('reuses only free project agents and preserves their working folder', async () => {
    const item = await service.create('p', 'r', {
      title: 'Existing agent output',
    });
    const second = await service.create('p', 'r', { title: 'Other output' });
    const now = Date.now();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'free-agent',
        projectId: 'p',
        workspacePath: root,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const folders = new ActiveFoldersService(database.db);
    folders.set(
      'p',
      'agent',
      'free-agent',
      { resourceId: 'w', relativePath: '' },
      { allowUnboundAgent: true },
    );
    expect(service.availableAgentIds('p', 'r', item.id)).toEqual([
      'free-agent',
    ]);
    expect(() =>
      service.registerAgent(
        'p',
        'r',
        item.id,
        999,
        'free-agent',
        undefined,
        true,
      ),
    ).toThrow('changed');
    expect(service.availableAgentIds('p', 'r', item.id)).toEqual([
      'free-agent',
    ]);
    service.registerAgent(
      'p',
      'r',
      item.id,
      item.version,
      'free-agent',
      undefined,
      true,
    );
    expect(folders.resolve('agent', 'free-agent')).toBe(root);
    expect(service.contextForConversation('free-agent')).toContain(
      'Existing agent output',
    );
    expect(service.availableAgentIds('p', 'r', second.id)).toEqual([]);
    expect(() =>
      service.registerAgent(
        'p',
        'r',
        second.id,
        second.version,
        'free-agent',
        undefined,
        true,
      ),
    ).toThrow('no longer available');
    expect(() =>
      service.registerAgent(
        'p',
        'r',
        second.id,
        second.version,
        'unknown-agent',
        undefined,
        true,
      ),
    ).toThrow('no longer available');
    expect(service.get('p', 'r', second.id).conversations).toEqual([]);
    expect(database.db.select().from(projectAgentThreads).all()).toHaveLength(
      1,
    );
  });
  it('registers a direct agent without creating any task and rejects stale associations atomically', async () => {
    const item = await service.create('p', 'r', {
      title: 'Standalone',
      criteria: 'Publishable',
    });
    service.registerAgent('p', 'r', item.id, item.version, 'direct-agent');
    expect(service.get('p', 'r', item.id).conversations).toContainEqual({
      type: 'agent',
      id: 'direct-agent',
    });
    expect(service.contextForConversation('direct-agent')).toContain(
      'Publishable',
    );
    expect(database.db.select().from(projectTasks).all()).toEqual([]);
    expect(
      new ActiveFoldersService(database.db).resolve('agent', 'direct-agent'),
    ).toBe(path.join(root, 'livrables', item.id));
    expect(() =>
      service.registerAgent('p', 'r', item.id, item.version, 'stale-direct'),
    ).toThrow('changed');
    expect(service.contextForConversation('stale-direct')).toBeNull();
    expect(
      database.db
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.threadId, 'stale-direct'))
        .get(),
    ).toBeUndefined();
    expect(() =>
      service.registerAgent(
        'p',
        'r',
        item.id,
        item.version + 1,
        'invalid-subtask-agent',
        'missing',
      ),
    ).toThrow();
    expect(service.contextForConversation('invalid-subtask-agent')).toBeNull();
  });

  it('registers an agent in the primary workspace and rolls back stale associations', async () => {
    const now = Date.now();
    database.db
      .insert(projectResources)
      .values({
        id: 'tasks',
        projectId: 'p',
        name: 'Tasks',
        type: 'task_board',
        config: {},
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectTaskStatuses)
      .values({
        id: 'todo',
        resourceId: 'tasks',
        name: 'To do',
        color: 'slate',
        kind: 'unassigned',
        position: 0,
        system: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectTasks)
      .values([
        {
          id: 'main-task',
          resourceId: 'tasks',
          statusId: 'todo',
          title: 'Main task',
          position: 0,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'agent-subtask',
          resourceId: 'tasks',
          statusId: 'todo',
          title: 'Produce output',
          parentTaskId: 'main-task',
          position: 1,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    const item = await service.create('p', 'r', {
      title: 'Agent output',
      criteria: 'Publishable',
      primaryTaskId: 'main-task',
    });
    expect(service.agentWorkspace('p', 'r', item.id, 1)).toBe(
      path.join(root, 'livrables', item.id),
    );
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'task-only',
        projectId: 'p',
        workspacePath: root,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .update(projectTasks)
      .set({ linkedThreadId: 'task-only' })
      .where(eq(projectTasks.id, 'main-task'))
      .run();
    expect(service.availableAgentIds('p', 'r', item.id)).not.toContain(
      'task-only',
    );
    expect(() =>
      service.registerAgent('p', 'r', item.id, 1, 'task-only', undefined, true),
    ).toThrow('no longer available');
    service.registerAgent('p', 'r', item.id, 1, 'new-agent', 'agent-subtask');
    expect(service.get('p', 'r', item.id).conversations).toContainEqual({
      type: 'agent',
      id: 'new-agent',
    });
    expect(service.contextForConversation('new-agent')).toContain(
      'Publishable',
    );
    expect(
      database.db
        .select()
        .from(projectTasks)
        .where(eq(projectTasks.id, 'agent-subtask'))
        .get(),
    ).toMatchObject({
      linkedThreadId: 'new-agent',
      executionMode: 'agent',
      agentState: 'ready',
    });
    expect(() =>
      service.registerAgent(
        'p',
        'r',
        item.id,
        1,
        'stale-agent',
        'agent-subtask',
      ),
    ).toThrow('already has an agent');
    expect(service.contextForConversation('stale-agent')).toBeNull();
  });
  it('accepts a hidden execution subtask when the deliverable has no task manager', async () => {
    const now = Date.now();
    database.db
      .insert(projectResources)
      .values({
        id: 'internal-tasks',
        projectId: 'p',
        name: 'Internal executions',
        type: 'task_board',
        config: { internal: true, purpose: 'deliverable_execution' },
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectTaskStatuses)
      .values({
        id: 'internal-todo',
        resourceId: 'internal-tasks',
        name: 'To do',
        color: 'slate',
        kind: 'unassigned',
        position: 0,
        system: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const item = await service.create('p', 'r', { title: 'Standalone' });
    database.db
      .insert(projectTasks)
      .values([
        {
          id: 'internal-parent',
          resourceId: 'internal-tasks',
          statusId: 'internal-todo',
          title: 'Standalone execution',
          labels: [`mergeron:deliverable:${item.id}`],
          position: 0,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'internal-subtask',
          resourceId: 'internal-tasks',
          statusId: 'internal-todo',
          title: 'Produce standalone',
          parentTaskId: 'internal-parent',
          position: 1,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    service.registerAgent(
      'p',
      'r',
      item.id,
      item.version,
      'internal-agent',
      'internal-subtask',
    );
    expect(service.contextForConversation('internal-agent')).toContain(
      'Standalone',
    );
    expect(service.board('p', 'r')).toMatchObject({
      taskManagers: [],
      tasks: [],
    });
  });
});
