import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projects,
  projectResources,
  projectWorkspaces,
  projectAgentThreads,
} from '../database/schema';
import { FilesService } from '../files/files.service';
import { IdentityService } from '../auth/identity.service';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { DocumentProtectionService } from './document-protection.service';
import { DocumentPublicationService } from './document-publication.service';
import { SECURITY_SETTING_KEYS } from '../settings/settings.definitions';
import type { SettingsService } from '../settings/settings.service';
import type { DatabaseService } from '../database/database.service';
import type { CodexProcessManager } from '../codex/codex-process-manager.service';

// macOS has no /proc. Preserve the same opened-handle path check in local tests;
// the Linux mount/descriptor boundary is additionally exercised on the dev host.
const descriptors = vi.hoisted(() => new Map<number, string>());
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      descriptors.set(file.fd, String(args[0]));
      return file;
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const match = /^\/proc\/self\/fd\/(\d+)$/.exec(String(args[0]));
      return actual.realpath(
        match ? descriptors.get(Number(match[1]))! : args[0],
      );
    },
  };
});

describe('agent saves retained documents as new versions', () => {
  let database: TestDatabase;
  let root: string;
  let deliverables: DeliverablesService;
  let publication: DocumentPublicationService;
  let item: Awaited<ReturnType<DeliverablesService['create']>>;

  beforeEach(async () => {
    vi.stubEnv('MERGERON_PUBLISHED_DOCUMENT_PROTECTION', 'required');
    database = createTestDatabase();
    root = await fs.mkdtemp(path.join(tmpdir(), 'agent-document-'));
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
    const files = new FilesService(
      {
        getStringSetting: (key: string) =>
          key === SECURITY_SETTING_KEYS.workspaceRoots ? root : '',
        getSetting: () => ({ value: '' }),
        onChange: () => () => {},
      } as unknown as SettingsService,
      database.db,
    );
    deliverables = new DeliverablesService(
      database.db,
      files,
      new IdentityService(database.db),
      new ActiveFoldersService(database.db),
    );
    const protection = new DocumentProtectionService(database.db, {
      databasePath: ':memory:',
    } as DatabaseService);
    publication = new DocumentPublicationService(
      database.db,
      deliverables,
      protection,
      {
        addListener: vi.fn(),
        addLifecycleListener: vi.fn(),
      } as unknown as CodexProcessManager,
    );
    item = await deliverables.create('p', 'r', { title: 'Report' });
  });

  afterEach(async () => {
    publication.onModuleDestroy();
    database.sqlite.close();
    await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    descriptors.clear();
  });

  async function request(
    input: Record<string, unknown>,
    content = 'Version one',
  ) {
    await publication.prepare('agent', 'Writer');
    const scope = publication['scopes'].get('agent')!;
    await fs.writeFile(path.join(scope.directory, 'report.docx'), content);
    expect(
      (await publication['readDraft'](scope, 'report.docx', 1024)).toString(),
    ).toBe(content);
    await fs.writeFile(
      path.join(scope.directory, 'publication-request.json'),
      JSON.stringify({
        requestId: 'save-1',
        resourceId: 'r',
        deliverableId: item.id,
        file: 'report.docx',
        comment: 'Written by agent',
        ...input,
      }),
    );
    await publication.scan(scope);
    return {
      scope,
      result: JSON.parse(
        await fs.readFile(
          path.join(scope.directory, 'publication-result.json'),
          'utf8',
        ),
      ) as Record<string, unknown>,
    };
  }

  it('retains a protected source, immutable V1, actor and version comment', async () => {
    const { result } = await request({});
    expect(result.status).toBe('published');
    const document = deliverables.board('p', 'r').deliverables[0].documents[0];
    expect(document.sourcePath).toContain(
      path.join(root, 'livrables', item.id, 'published'),
    );
    expect(document.versions[0]).toMatchObject({
      number: 1,
      authorName: 'Agent — Writer',
      comment: 'Written by agent',
    });
    expect(await fs.readFile(document.sourcePath, 'utf8')).toBe('Version one');
    expect(await fs.readFile(document.versions[0].snapshotPath, 'utf8')).toBe(
      'Version one',
    );
  });

  it('creates V2 and refuses stale writes without overwriting either version', async () => {
    await request({});
    const original = deliverables.board('p', 'r').deliverables[0].documents[0];
    const second = await request(
      { requestId: 'save-2', documentId: original.id, expectedVersion: 1 },
      'Version two',
    );
    expect(second.result.status).toBe('published');
    const stale = await request(
      { requestId: 'save-3', documentId: original.id, expectedVersion: 1 },
      'Stale',
    );
    expect(stale.result.status).toBe('failed');
    const document = deliverables.board('p', 'r').deliverables[0].documents[0];
    expect(document.currentVersionNumber).toBe(2);
    expect(await fs.readFile(document.sourcePath, 'utf8')).toBe('Version two');
    expect(
      await fs.readFile(
        document.versions.find((version) => version.number === 1)!.snapshotPath,
        'utf8',
      ),
    ).toBe('Version one');
    expect(
      await fs.readFile(
        document.versions.find((version) => version.number === 2)!.snapshotPath,
        'utf8',
      ),
    ).toBe('Version two');
  });

  it('does not republish a request or save a document without an explicit request', async () => {
    const { scope } = await request({});
    await publication.scan(scope);
    expect(
      deliverables.board('p', 'r').deliverables[0].documents[0]
        .currentVersionNumber,
    ).toBe(1);
    await fs.writeFile(
      path.join(scope.directory, 'temporary.txt'),
      'Not a retained document',
    );
    await publication.scan(scope);
    expect(deliverables.board('p', 'r').deliverables[0].documents).toHaveLength(
      1,
    );
  });

  it('restores the retained source if writing the new snapshot fails', async () => {
    await request({});
    const original = deliverables.board('p', 'r').deliverables[0].documents[0];
    const copy = fs.copyFile;
    const failure = vi
      .spyOn(fs, 'copyFile')
      .mockImplementation(async (source, target, mode) => {
        if (String(target).includes(`${path.sep}history${path.sep}`))
          throw new Error('Simulated storage failure');
        return copy(source, target, mode);
      });
    try {
      const { result, scope } = await request(
        { requestId: 'failed-v2', documentId: original.id, expectedVersion: 1 },
        'Version two',
      );
      expect(result.status).toBe('failed');
      expect(await fs.readFile(original.sourcePath, 'utf8')).toBe(
        'Version one',
      );
      expect(
        await fs.readFile(path.join(scope.directory, 'report.docx'), 'utf8'),
      ).toBe('Version two');
      expect(
        deliverables.board('p', 'r').deliverables[0].documents[0]
          .currentVersionNumber,
      ).toBe(1);
    } finally {
      failure.mockRestore();
    }
  });

  it('serializes concurrent saves and preserves the losing draft', async () => {
    await request({});
    const original = deliverables.board('p', 'r').deliverables[0].documents[0];
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'agent-2',
        projectId: 'p',
        workspacePath: root,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    await publication.prepare('agent-2', 'Second writer');
    const scopes = [
      publication['scopes'].get('agent')!,
      publication['scopes'].get('agent-2')!,
    ];
    for (const [index, scope] of scopes.entries()) {
      await fs.writeFile(
        path.join(scope.directory, 'report.docx'),
        `Candidate ${index}`,
      );
      await fs.writeFile(
        path.join(scope.directory, 'publication-request.json'),
        JSON.stringify({
          requestId: `concurrent-${index}`,
          resourceId: 'r',
          deliverableId: item.id,
          documentId: original.id,
          expectedVersion: 1,
          file: 'report.docx',
          comment: 'Concurrent update',
        }),
      );
    }
    await Promise.all(scopes.map((scope) => publication.scan(scope)));
    const statuses = await Promise.all(
      scopes.map(
        async (scope) =>
          (
            JSON.parse(
              await fs.readFile(
                path.join(scope.directory, 'publication-result.json'),
                'utf8',
              ),
            ) as Record<string, unknown>
          ).status,
      ),
    );
    expect(statuses.sort()).toEqual(['failed', 'published']);
    const document = deliverables.board('p', 'r').deliverables[0].documents[0];
    expect(document.currentVersionNumber).toBe(2);
    expect(
      await fs.readFile(
        document.versions.find((version) => version.number === 1)!.snapshotPath,
        'utf8',
      ),
    ).toBe('Version one');
    expect(await fs.readFile(document.sourcePath, 'utf8')).toBe(
      await fs.readFile(
        document.versions.find((version) => version.number === 2)!.snapshotPath,
        'utf8',
      ),
    );
  });

  it('refuses a foreign board and preserves the draft', async () => {
    const { scope, result } = await request({ resourceId: 'foreign-board' });
    expect(result.status).toBe('failed');
    expect(
      await fs.readFile(path.join(scope.directory, 'report.docx'), 'utf8'),
    ).toBe('Version one');
    expect(deliverables.board('p', 'r').deliverables[0].documents).toHaveLength(
      0,
    );
  });

  it('refuses symlinks and hardlinks instead of copying server files', async () => {
    await publication.prepare('agent');
    const scope = publication['scopes'].get('agent')!;
    const secret = path.join(root, 'secret.docx');
    await fs.writeFile(secret, 'Must not be retained');
    for (const [index, link] of [fs.symlink, fs.link].entries()) {
      const draft = path.join(scope.directory, `linked-${index}.docx`);
      await link(secret, draft);
      await fs.writeFile(
        path.join(scope.directory, 'publication-request.json'),
        JSON.stringify({
          requestId: `unsafe-${index}`,
          resourceId: 'r',
          deliverableId: item.id,
          file: path.basename(draft),
          comment: '',
        }),
      );
      await publication.scan(scope);
      expect(
        (
          JSON.parse(
            await fs.readFile(
              path.join(scope.directory, 'publication-result.json'),
              'utf8',
            ),
          ) as Record<string, unknown>
        ).status,
      ).toBe('failed');
    }
    expect(deliverables.board('p', 'r').deliverables[0].documents).toHaveLength(
      0,
    );
  });

  it('does not provide a writer when the project has no deliverables manager', async () => {
    database.db.delete(projectResources).run();
    const prepared = await publication.prepare('agent');
    expect(prepared?.context).toContain('no deliverables manager');
    expect(publication['scopes'].size).toBe(0);
  });
});
