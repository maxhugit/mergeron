import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projects,
  projectWorkspaces,
  projectAgentThreads,
  simpleChatThreads,
  projectResources,
  projectDeliverables,
  projectDeliverableVersions,
  projectDeliverableDocuments,
  projectDeliverableDocumentVersions,
  people,
  projectParticipants,
} from '../database/schema';
import { ProjectWorkspaceLayout } from './project-workspace-layout';
import { projectSystemPath } from './workspace-structure';
import { FilesService } from '../files/files.service';
import type { SettingsService } from '../settings/settings.service';
import { SECURITY_SETTING_KEYS } from '../settings/settings.definitions';
import { ProjectsService } from './projects.service';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { IdentityService } from '../auth/identity.service';
import { accessContext } from '../auth/access-context';
import { ProjectKnowledgeService } from '../project-knowledge/project-knowledge.service';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import {
  PROJECT_WORKSPACE_INSTRUCTIONS,
  LEGACY_PROJECT_WORKSPACE_INSTRUCTIONS,
} from './workspace-structure';

describe('permanent project workspaces', () => {
  let database: TestDatabase;
  let root: string;
  let legacy: string;
  let layout: ProjectWorkspaceLayout;
  let files: FilesService;
  beforeEach(async () => {
    database = createTestDatabase();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-layout-'));
    legacy = path.join(root, 'existing');
    await fs.mkdir(legacy);
    await fs.writeFile(path.join(legacy, 'AGENTS.md'), 'Existing instructions');
    const now = Date.now();
    database.db
      .insert(projects)
      .values({
        id: 'project-id',
        name: 'My project',
        workspacePath: legacy,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectWorkspaces)
      .values({
        id: 'legacy',
        projectId: 'project-id',
        name: 'Existing',
        path: legacy,
        primary: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'agent',
        projectId: 'project-id',
        workspacePath: legacy,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(simpleChatThreads)
      .values({
        id: 'chat',
        title: 'Chat',
        model: 'codex',
        projectId: 'project-id',
        cwd: legacy,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    layout = new ProjectWorkspaceLayout(database.db, root);
    files = new FilesService(
      {
        getStringSetting: (key: string) =>
          key === SECURITY_SETTING_KEYS.workspaceRoots ? root : '',
        getSetting: () => ({ value: '' }),
        onChange: () => () => {},
      } as unknown as SettingsService,
      database.db,
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    files.onModuleDestroy();
    database.sqlite.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function legacyPrimary() {
    await layout.migrate();
    const primary = path.join(root, 'project-id');
    await fs.rename(projectSystemPath(primary), path.join(primary, '.webui'));
    await fs.writeFile(
      path.join(primary, '.webui/project.json'),
      JSON.stringify({ projectId: 'project-id', layoutVersion: 1 }),
    );
    await fs.writeFile(
      path.join(primary, 'AGENTS.md'),
      LEGACY_PROJECT_WORKSPACE_INSTRUCTIONS,
    );
    database.db
      .update(projects)
      .set({ workspaceLayoutVersion: 1 })
      .where(eq(projects.id, 'project-id'))
      .run();
    return primary;
  }

  it('migrates an embedded v2 system while preserving working files, history and old administrative links', async () => {
    await layout.migrate();
    const primary = path.join(root, 'project-id');
    const system = projectSystemPath(primary);
    await fs.rename(system, path.join(primary, '.mergeron'));
    await fs.writeFile(
      path.join(primary, '.mergeron/project.json'),
      JSON.stringify({ projectId: 'project-id', layoutVersion: 2 }),
    );
    await fs.writeFile(
      path.join(primary, '.mergeron/history/keep.bin'),
      'historical bytes',
    );
    await fs.writeFile(
      path.join(primary, 'documents/report.txt'),
      'working bytes',
    );
    await fs.mkdir(path.join(primary, '.agent-document-drafts/lease'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(primary, '.agent-document-drafts/lease/draft.pptx'),
      'unfinished draft',
    );
    database.db.update(projects).set({ workspaceLayoutVersion: 2 }).run();
    await layout.migrate();
    expect(
      await fs.readFile(path.join(system, 'history/keep.bin'), 'utf8'),
    ).toBe('historical bytes');
    expect(
      await fs.readFile(
        path.join(system, 'draft-archive/lease/draft.pptx'),
        'utf8',
      ),
    ).toBe('unfinished draft');
    expect(
      await fs.readFile(path.join(primary, 'documents/report.txt'), 'utf8'),
    ).toBe('working bytes');
    expect(
      await files.resolveSafePath(
        path.join(primary, '.mergeron/history/keep.bin'),
      ),
    ).toBe(await fs.realpath(path.join(system, 'history/keep.bin')));
    await expect(
      fs.lstat(path.join(primary, '.mergeron')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      files.writeFile(path.join(system, 'history/keep.bin'), 'forbidden'),
    ).rejects.toThrow('read-only');
    await layout.migrate();
    expect(
      await fs.readFile(path.join(system, 'history/keep.bin'), 'utf8'),
    ).toBe('historical bytes');
  });

  it('refuses system access for project members through direct, legacy and symbolic-link paths', async () => {
    await layout.migrate();
    database.db
      .insert(people)
      .values({
        id: 'reader',
        reference: 'reader',
        name: 'Reader',
        role: 'standard',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(projectParticipants)
      .values({ projectId: 'project-id', personId: 'reader', createdAt: 1 })
      .run();
    const identity = {
      kind: 'person' as const,
      personId: 'reader',
      name: 'Reader',
      role: 'standard' as const,
      active: true,
    };
    const identities = new IdentityService(database.db);
    const primary = path.join(root, 'project-id');
    const system = projectSystemPath(primary);
    await fs.symlink(system, path.join(primary, 'documents/system-link'));
    const context = { identity, identities };
    for (const denied of [
      system,
      path.join(system, 'knowledge/AGENTS.md'),
      path.join(primary, '.mergeron/knowledge/AGENTS.md'),
      path.join(primary, 'documents/system-link/knowledge/AGENTS.md'),
    ]) {
      await expect(
        accessContext.run(context, () => files.resolveSafePath(denied)),
      ).rejects.toThrow();
      await expect(
        accessContext.run(context, () => files.resolveWatchPath(denied)),
      ).rejects.toThrow();
    }
    expect(
      await accessContext.run(context, () =>
        files.resolveSafePath(path.join(primary, 'documents')),
      ),
    ).toContain('documents');
    const entries = await accessContext.run(context, () =>
      files.readDirectory(path.join(primary, 'documents')),
    );
    expect(entries.some((entry) => entry.name === 'system-link')).toBe(false);
  });

  it('extracts imported business files and retains workspace and conversation references', async () => {
    const primary = await legacyPrimary();
    const oldWorkspace = path.join(
      primary,
      '.webui/imported-workspaces/source',
    );
    const oldAttachment = path.join(
      primary,
      '.webui/imported-attachments/notes.txt',
    );
    await fs.mkdir(oldWorkspace, { recursive: true });
    await fs.mkdir(path.dirname(oldAttachment), { recursive: true });
    await fs.writeFile(path.join(oldWorkspace, 'keep.txt'), 'source bytes');
    await fs.writeFile(oldAttachment, 'attachment bytes');
    database.db
      .insert(projectWorkspaces)
      .values({
        id: 'imported',
        projectId: 'project-id',
        name: 'Imported',
        path: oldWorkspace,
        primary: false,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .update(projectAgentThreads)
      .set({ workspacePath: oldWorkspace })
      .run();
    database.db.update(simpleChatThreads).set({ cwd: oldWorkspace }).run();
    await layout.migrate();
    const destination = path.join(
      primary,
      'sources/imported-workspaces/source',
    );
    expect(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8')).toBe(
      'source bytes',
    );
    expect(
      await fs.readFile(
        path.join(primary, 'documents/imported-attachments/notes.txt'),
        'utf8',
      ),
    ).toBe('attachment bytes');
    expect(
      database.db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.id, 'imported'))
        .get()?.path,
    ).toBe(destination);
    expect(
      database.db.select().from(projectAgentThreads).get()?.workspacePath,
    ).toBe(destination);
    expect(database.db.select().from(simpleChatThreads).get()?.cwd).toBe(
      destination,
    );
    expect(await files.resolveSafePath(oldAttachment)).toBe(
      await fs.realpath(
        path.join(primary, 'documents/imported-attachments/notes.txt'),
      ),
    );
    await layout.migrate();
    expect(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8')).toBe(
      'source bytes',
    );
  });

  async function historicalDeliverable(primary: string) {
    const now = Date.now();
    const sourcePath = path.join(primary, 'documents/report.txt');
    const snapshotPath = path.join(
      primary,
      '.webui/history/deliverables/d/v/0-report.txt',
    );
    const documentSnapshot = path.join(
      primary,
      '.webui/history/deliverables/d/documents/doc/dv/report.txt',
    );
    const changes = path.join(path.dirname(documentSnapshot), 'changes.zip');
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.mkdir(path.dirname(documentSnapshot), { recursive: true });
    for (const name of [sourcePath, snapshotPath, documentSnapshot])
      await fs.writeFile(name, 'Preserved report');
    await fs.writeFile(changes, 'Office history');
    const sha256 = createHash('sha256')
      .update('Preserved report')
      .digest('hex');
    const size = Buffer.byteLength('Preserved report');
    database.db
      .insert(projectResources)
      .values({
        id: 'r',
        projectId: 'project-id',
        name: 'Deliverables',
        type: 'deliverable_board',
        config: {},
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectDeliverables)
      .values({
        id: 'd',
        resourceId: 'r',
        title: 'Report',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectDeliverableVersions)
      .values({
        id: 'v',
        deliverableId: 'd',
        number: 1,
        files: [{ name: 'report.txt', sourcePath, snapshotPath, sha256, size }],
        createdAt: now,
      })
      .run();
    database.db
      .insert(projectDeliverableDocuments)
      .values({
        id: 'doc',
        deliverableId: 'd',
        name: 'report.txt',
        format: 'txt',
        sourcePath,
        currentVersionNumber: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectDeliverableDocumentVersions)
      .values({
        id: 'dv',
        documentId: 'doc',
        number: 1,
        fileName: 'report.txt',
        sourcePath,
        snapshotPath: documentSnapshot,
        sha256,
        size,
        authorName: 'Maxime',
        onlyofficeChangesPath: changes,
        createdAt: now,
      })
      .run();
    return { sourcePath, snapshotPath, documentSnapshot, changes };
  }

  it('migrates knowledge and downloadable deliverable history without changing source files or active folders', async () => {
    const primary = await legacyPrimary();
    const old = await historicalDeliverable(primary);
    await fs.writeFile(
      path.join(primary, '.webui/knowledge/DECISIONS.md'),
      'Keep this decision',
    );
    await layout.migrate();
    const service = new DeliverablesService(
      database.db,
      files,
      new IdentityService(database.db),
      new ActiveFoldersService(database.db),
    );
    const migratedFile = await service.file('project-id', 'r', 'd', 'v', 0);
    const migratedDocument = await service.documentVersionFile(
      'project-id',
      'r',
      'd',
      'doc',
      'dv',
    );
    expect(await fs.readFile(migratedFile.snapshotPath, 'utf8')).toBe(
      'Preserved report',
    );
    expect(await fs.readFile(migratedDocument.path, 'utf8')).toBe(
      'Preserved report',
    );
    expect(
      await fs.readFile(
        migratedDocument.version.onlyofficeChangesPath!,
        'utf8',
      ),
    ).toBe('Office history');
    expect(migratedFile.sourcePath).toBe(old.sourcePath);
    expect(migratedDocument.version.sourcePath).toBe(old.sourcePath);
    expect(
      (await new ProjectKnowledgeService(database.db).read('project-id')).files[
        'DECISIONS.md'
      ],
    ).toBe('Keep this decision');
    expect(await fs.readFile(path.join(primary, 'AGENTS.md'), 'utf8')).toBe(
      PROJECT_WORKSPACE_INSTRUCTIONS,
    );
    expect(
      database.db.select().from(projectAgentThreads).get()?.workspacePath,
    ).toBe(legacy);
    expect(database.db.select().from(simpleChatThreads).get()?.cwd).toBe(
      legacy,
    );
    await expect(fs.lstat(path.join(primary, '.webui'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const before = database.db
      .select()
      .from(projectDeliverableDocumentVersions)
      .all();
    await layout.migrate();
    expect(
      database.db.select().from(projectDeliverableDocumentVersions).all(),
    ).toEqual(before);
  });

  it('replays the metadata transaction after an interruption following the directory rename', async () => {
    const primary = await legacyPrimary();
    await historicalDeliverable(primary);
    vi.spyOn(database.db, 'transaction').mockImplementationOnce(() => {
      throw new Error('Interrupted');
    });
    await expect(layout.migrate()).rejects.toThrow('Interrupted');
    expect(
      database.db.select().from(projects).get()?.workspaceLayoutVersion,
    ).toBe(1);
    expect((await fs.lstat(projectSystemPath(primary))).isDirectory()).toBe(
      true,
    );
    expect(
      database.db.select().from(projectDeliverableVersions).get()?.files[0]
        .snapshotPath,
    ).toContain('/.webui/');
    await layout.migrate();
    expect(
      database.db.select().from(projects).get()?.workspaceLayoutVersion,
    ).toBe(3);
    const file = database.db.select().from(projectDeliverableVersions).get()!
      .files[0];
    expect(file.snapshotPath).toContain('/.mergeron-system/');
    expect(await fs.readFile(file.snapshotPath, 'utf8')).toBe(
      'Preserved report',
    );
  });

  it('preserves customized root instructions and similarly named user paths', async () => {
    const primary = await legacyPrimary();
    await historicalDeliverable(primary);
    await fs.writeFile(
      path.join(primary, 'AGENTS.md'),
      'Custom instructions mentioning .webui',
    );
    const version = database.db
      .select()
      .from(projectDeliverableVersions)
      .get()!;
    const siblingPath = path.join(primary, '.webui-backup/report.txt');
    database.db
      .update(projectDeliverableVersions)
      .set({
        files: [
          ...version.files,
          { ...version.files[0], snapshotPath: siblingPath },
        ],
      })
      .where(eq(projectDeliverableVersions.id, 'v'))
      .run();
    await layout.migrate();
    expect(await fs.readFile(path.join(primary, 'AGENTS.md'), 'utf8')).toBe(
      'Custom instructions mentioning .webui',
    );
    expect(
      database.db.select().from(projectDeliverableVersions).get()?.files[1]
        .snapshotPath,
    ).toBe(siblingPath);
  });

  it('does not merge colliding system directories or update the database', async () => {
    const primary = await legacyPrimary();
    await fs.mkdir(path.join(primary, '.mergeron'));
    await fs.writeFile(path.join(primary, '.mergeron/keep.txt'), 'Keep me');
    await expect(layout.migrate()).rejects.toThrow('Both .webui and .mergeron');
    expect(
      await fs.readFile(path.join(primary, '.mergeron/keep.txt'), 'utf8'),
    ).toBe('Keep me');
    expect((await fs.lstat(path.join(primary, '.webui'))).isDirectory()).toBe(
      true,
    );
    expect(
      database.db.select().from(projects).get()?.workspaceLayoutVersion,
    ).toBe(1);
  });

  it('does not rewrite history belonging to a different project', async () => {
    const primary = await legacyPrimary();
    const old = await historicalDeliverable(primary);
    database.db
      .insert(projects)
      .values({
        id: 'other',
        name: 'Other',
        workspacePath: path.join(root, 'other'),
        workspaceLayoutVersion: 3,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(projectResources)
      .values({
        id: 'other-resource',
        projectId: 'other',
        name: 'Other',
        type: 'deliverable_board',
        config: {},
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(projectDeliverables)
      .values({
        id: 'other-deliverable',
        resourceId: 'other-resource',
        title: 'Other',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const files = database.db.select().from(projectDeliverableVersions).get()!
      .files;
    database.db
      .insert(projectDeliverableVersions)
      .values({
        id: 'other-version',
        deliverableId: 'other-deliverable',
        number: 1,
        files,
        createdAt: 1,
      })
      .run();
    await layout.migrate();
    expect(
      database.db
        .select()
        .from(projectDeliverableVersions)
        .where(eq(projectDeliverableVersions.id, 'other-version'))
        .get()?.files[0].snapshotPath,
    ).toBe(old.snapshotPath);
  });

  it('recreates a missing structural folder without moving user folders', async () => {
    const primary = await legacyPrimary();
    await fs.rename(
      path.join(primary, 'documents'),
      path.join(primary, 'my-documents'),
    );
    await fs.writeFile(path.join(primary, 'my-documents/note.md'), 'Keep me');
    await layout.migrate();
    expect(
      (await fs.lstat(path.join(primary, 'documents'))).isDirectory(),
    ).toBe(true);
    expect(
      await fs.readFile(path.join(primary, 'my-documents/note.md'), 'utf8'),
    ).toBe('Keep me');
  });

  it('rejects a structural symlink before changing the system directory', async () => {
    const primary = await legacyPrimary();
    await fs.rmdir(path.join(primary, 'sources'));
    await fs.symlink(legacy, path.join(primary, 'sources'));
    await expect(layout.migrate()).rejects.toThrow('invalid directory');
    expect((await fs.lstat(path.join(primary, '.webui'))).isDirectory()).toBe(
      true,
    );
    await expect(
      fs.lstat(path.join(primary, '.mergeron')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['system', 'marker', 'knowledge', 'history'] as const)(
    'rejects a symbolic link in the legacy %s before renaming',
    async (part) => {
      const primary = await legacyPrimary();
      const source = path.join(
        primary,
        '.webui',
        ...{
          system: [],
          marker: ['project.json'],
          knowledge: ['knowledge'],
          history: ['history'],
        }[part],
      );
      const outside = path.join(root, `outside-${part}`);
      await fs.rename(source, outside);
      await fs.symlink(outside, source);
      await expect(layout.migrate()).rejects.toThrow();
      await expect(
        fs.lstat(path.join(primary, '.mergeron')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        database.db.select().from(projects).get()?.workspaceLayoutVersion,
      ).toBe(1);
    },
  );

  it('rejects a legacy marker belonging to another project', async () => {
    const primary = await legacyPrimary();
    await fs.writeFile(
      path.join(primary, '.webui/project.json'),
      JSON.stringify({ projectId: 'other', layoutVersion: 1 }),
    );
    await expect(layout.migrate()).rejects.toThrow('another project');
    expect((await fs.lstat(path.join(primary, '.webui'))).isDirectory()).toBe(
      true,
    );
    expect(
      database.db.select().from(projects).get()?.workspaceLayoutVersion,
    ).toBe(1);
  });

  it('does not recreate a missing version one principal', async () => {
    const primary = await legacyPrimary();
    await fs.rm(primary, { recursive: true });
    await layout.migrate();
    await expect(fs.lstat(primary)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      database.db.select().from(projects).get()?.workspaceLayoutVersion,
    ).toBe(1);
  });

  it.each(['documents', 'sources', 'livrables'])(
    'protects the structural %s directory while allowing its contents',
    async (name) => {
      await layout.migrate();
      const directory = path.join(root, 'project-id', name);
      await expect(files.renamePath(directory, 'renamed')).rejects.toThrow();
      await expect(
        files.movePath(directory, path.join(legacy, name)),
      ).rejects.toThrow();
      await expect(files.deletePath(directory, true)).rejects.toThrow();
      await files.writeFile(path.join(directory, 'note.md'), 'Allowed');
      await files.renamePath(path.join(directory, 'note.md'), 'renamed.md');
      expect(
        await fs.readFile(path.join(directory, 'renamed.md'), 'utf8'),
      ).toBe('Allowed');
      await files.deletePath(path.join(directory, 'renamed.md'));
    },
  );

  it('creates a principal from the immutable generated ID and rejects custom primary paths', async () => {
    const prepare = layout.prepare.bind(layout) as (
      id: string,
    ) => Promise<string>;
    vi.spyOn(ProjectWorkspaceLayout.prototype, 'prepare').mockImplementation(
      (id) => prepare(id),
    );
    const service = new ProjectsService(
      files,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      database.db,
    );
    const project = await service.create('Renamable project');
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.workspacePath).toBe(path.join(root, project.id));
    expect(project.workspaceLayoutVersion).toBe(3);
    expect(
      await fs.stat(
        path.join(projectSystemPath(project.workspacePath), 'history'),
      ),
    ).toMatchObject({});
    await expect(service.create('Custom', legacy)).rejects.toThrow(
      'generated from the project ID',
    );
  });

  it('recovers filesystem preparation completed before a database transaction', async () => {
    const primary = await layout.prepare('project-id');
    await fs.writeFile(
      path.join(projectSystemPath(primary), 'knowledge/CONNAISSANCES.md'),
      'Preserved',
    );
    await layout.migrate();
    expect(
      database.db.select().from(projects).get()?.workspaceLayoutVersion,
    ).toBe(3);
    expect(
      await fs.readFile(
        path.join(projectSystemPath(primary), 'knowledge/CONNAISSANCES.md'),
        'utf8',
      ),
    ).toBe('Preserved');
  });

  it('migrates once without moving files or changing active conversation workspaces', async () => {
    await layout.migrate();
    const primary = path.join(root, 'project-id');
    expect(database.db.select().from(projects).get()).toMatchObject({
      workspacePath: primary,
      workspaceLayoutVersion: 3,
    });
    expect(database.db.select().from(projectWorkspaces).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'legacy', path: legacy, primary: false }),
        expect.objectContaining({ path: primary, primary: true }),
      ]),
    );
    expect(
      database.db.select().from(projectAgentThreads).get()?.workspacePath,
    ).toBe(legacy);
    expect(database.db.select().from(simpleChatThreads).get()?.cwd).toBe(
      legacy,
    );
    expect(await fs.readFile(path.join(legacy, 'AGENTS.md'), 'utf8')).toBe(
      'Existing instructions',
    );
    await fs.writeFile(
      path.join(projectSystemPath(primary), 'knowledge/DECISIONS.md'),
      'A decision',
    );
    await layout.migrate();
    expect(database.db.select().from(projectWorkspaces).all()).toHaveLength(2);
    expect(
      await fs.readFile(
        path.join(projectSystemPath(primary), 'knowledge/DECISIONS.md'),
        'utf8',
      ),
    ).toBe('A decision');
  });

  it('does not adopt an unrelated directory or partially update project metadata', async () => {
    await fs.mkdir(path.join(root, 'project-id'));
    await fs.writeFile(path.join(root, 'project-id', 'user.txt'), 'Keep me');
    await expect(layout.migrate()).rejects.toThrow('ownership marker');
    expect(database.db.select().from(projects).get()?.workspacePath).toBe(
      legacy,
    );
    expect(database.db.select().from(projectWorkspaces).all()).toHaveLength(1);
    expect(
      await fs.readFile(path.join(root, 'project-id', 'user.txt'), 'utf8'),
    ).toBe('Keep me');
  });

  it('retains a missing migrated primary instead of silently creating or promoting one', async () => {
    await layout.migrate();
    await fs.rm(path.join(root, 'project-id'), { recursive: true });
    const service = new ProjectsService(
      files,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      database.db,
    );
    expect(await service.reconcileMissingWorkspaces()).toMatchObject({
      removed: [],
      unresolved: [path.join(root, 'project-id')],
    });
    await layout.migrate();
    await expect(fs.stat(path.join(root, 'project-id'))).rejects.toThrow();
    expect(
      database.db
        .select()
        .from(projectWorkspaces)
        .all()
        .find((w) => w.primary)?.path,
    ).toBe(path.join(root, 'project-id'));
  });

  it('preserves primary files when the project is deleted without a physical deletion selection', async () => {
    await layout.migrate();
    database.db.delete(projectAgentThreads).run();
    const service = new ProjectsService(
      files,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      database.db,
    );
    const result = await service.remove('project-id', 'My project');
    expect(result.deletedWorkspaces).toEqual([]);
    expect(result.preservedWorkspaces).toContain(path.join(root, 'project-id'));
    expect(database.db.select().from(projects).all()).toHaveLength(0);
    expect(
      await fs.stat(projectSystemPath(path.join(root, 'project-id'))),
    ).toMatchObject({});
  });

  it('allows explicit primary deletion only after confirmed project removal', async () => {
    await layout.migrate();
    database.db.delete(projectAgentThreads).run();
    const primary = database.db
      .select()
      .from(projectWorkspaces)
      .all()
      .find((w) => w.primary)!;
    const removeDirectory = vi
      .spyOn(files, 'deleteManagedWorkspace')
      .mockImplementation(async (target) => {
        expect(database.db.select().from(projects).all()).toHaveLength(0);
        expect(() => files.assertProjectPathMutable(target)).not.toThrow();
        await fs.rm(target, { recursive: true });
      });
    const service = new ProjectsService(
      files,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      database.db,
    );
    await expect(
      service.remove('project-id', 'Wrong name', [primary.id]),
    ).rejects.toThrow('confirmation');
    expect(removeDirectory).not.toHaveBeenCalled();
    expect(
      await service.remove('project-id', 'My project', [primary.id]),
    ).toMatchObject({
      deletedWorkspaces: [primary.path],
      preservedWorkspaces: [legacy],
    });
    await expect(fs.stat(primary.path)).rejects.toThrow();
    expect(await fs.readFile(path.join(legacy, 'AGENTS.md'), 'utf8')).toBe(
      'Existing instructions',
    );
  });

  it('protects primary roots, ancestors and system files while allowing ordinary content', async () => {
    await layout.migrate();
    const primary = path.join(root, 'project-id');
    await expect(files.deletePath(primary, true)).rejects.toThrow();
    await expect(
      files.movePath(primary, path.join(root, 'moved')),
    ).rejects.toThrow();
    await expect(files.renamePath(primary, 'renamed')).rejects.toThrow();
    await expect(
      files.writeFile(
        path.join(projectSystemPath(primary), 'knowledge/DECISIONS.md'),
        'Overwrite',
      ),
    ).rejects.toThrow();
    expect(() => files.assertProjectPathMutable(root)).toThrow();
    await fs.symlink(primary, path.join(root, 'alias'));
    await expect(
      files.deletePath(path.join(root, 'alias'), true),
    ).rejects.toThrow();
    await files.writeFile(
      path.join(primary, 'documents', 'note.md'),
      'Allowed',
    );
    expect(
      await fs.readFile(path.join(primary, 'documents/note.md'), 'utf8'),
    ).toBe('Allowed');
  });

  it('rejects primary detachment and secondary promotion', async () => {
    await layout.migrate();
    const service = new ProjectsService(
      files,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      database.db,
    );
    const primary = database.db
      .select()
      .from(projectWorkspaces)
      .all()
      .find((w) => w.primary)!;
    expect(() => service.detachWorkspace('project-id', primary.id)).toThrow(
      'only be removed with its project',
    );
    expect(() => service.setDefaultWorkspace('project-id', 'legacy')).toThrow(
      'permanent',
    );
    service.rename('project-id', 'New display name');
    expect(database.db.select().from(projects).get()?.workspacePath).toBe(
      primary.path,
    );
  });
});
