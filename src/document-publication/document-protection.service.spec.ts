import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentProtectionService } from './document-protection.service';
import {
  projects,
  projectWorkspaces,
  projectDeliverableDocuments,
  projectDeliverableDocumentVersions,
} from '../database/schema';
import type { AppDatabase } from '../database/database.constants';
import type { DatabaseService } from '../database/database.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';

const files = vi.hoisted(() => ({
  missing: new Set<string>(),
  copy: vi.fn(),
  updates: [] as unknown[],
}));
vi.mock('node:fs/promises', () => {
  const check = (target: string) => {
    if (files.missing.has(target))
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    return Promise.resolve(target);
  };
  return {
    constants: { X_OK: 1, COPYFILE_EXCL: 2 },
    copyFile: files.copy,
    access: check,
    realpath: check,
    mkdir: () => Promise.resolve(undefined),
    lstat: async (target: string) => {
      await check(target);
      return {
        isDirectory: () => true,
        isSymbolicLink: () => false,
        isFile: () => true,
        nlink: 1,
      };
    },
    stat: () => Promise.resolve({ isDirectory: () => true }),
  };
});

describe('unavailable document project isolation', () => {
  beforeEach(() => {
    files.missing.clear();
    files.copy.mockReset().mockResolvedValue(undefined);
    files.updates.length = 0;
    vi.stubEnv('MERGERON_PUBLISHED_DOCUMENT_PROTECTION', 'required');
    vi.stubGlobal('process', { ...process, platform: 'linux' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function service(missingDocument: boolean, layoutVersion = 1) {
    const project = {
      id: 'broken',
      workspaceLayoutVersion: layoutVersion,
      workspacePath: '/workspaces/broken',
    };
    const records = new Map<unknown, unknown[]>([
      [
        projects,
        [
          project,
          {
            id: 'good',
            workspaceLayoutVersion: 1,
            workspacePath: '/workspaces/good',
          },
        ],
      ],
      [
        projectWorkspaces,
        [
          { projectId: 'broken', path: '/workspaces/broken' },
          { projectId: 'good', path: '/workspaces/good' },
        ],
      ],
      [
        projectDeliverableDocuments,
        missingDocument
          ? [
              {
                project,
                document: {
                  id: 'd',
                  deliverableId: 'l',
                  name: 'report.docx',
                  previousSourcePaths: [],
                  sourcePath: '/workspaces/broken/report.docx',
                },
              },
            ]
          : [],
      ],
      [projectDeliverableDocumentVersions, []],
    ]);
    const db = {
      update: () => ({
        set: (value: unknown) => {
          files.updates.push(value);
          return { where: () => ({ run: () => ({ changes: 1 }) }) };
        },
      }),
      select: () => ({
        from: (table: unknown) => {
          const query = {
            all: () => records.get(table) ?? [],
            innerJoin: () => query,
          };
          return query;
        },
      }),
    } as unknown as AppDatabase;
    return new DocumentProtectionService(db, {
      databasePath: '/home/codex/.codex/webui.sqlite',
    } as DatabaseService);
  }

  it('quarantines a missing source without blocking an unrelated project', async () => {
    files.missing.add('/workspaces/broken/report.docx');
    const protection = service(true);
    const plan = await protection.plan();
    expect(plan?.publishedRoots).toContain('/workspaces/broken');
    expect(plan?.publishedRoots).not.toContain('/workspaces');
    expect(() =>
      protection.assertWorkspaceAvailable('/workspaces/broken/code'),
    ).toThrow('unavailable');
    expect(() =>
      protection.assertWorkspaceAvailable('/workspaces/good'),
    ).not.toThrow();
  });

  it('does not restart a fresh agent when a Git copy only adds a redundant writable mount', async () => {
    const protection = service(false, 3);
    const initial = (await protection.plan())!;
    protection.accept(initial);
    const clone = '/workspaces/broken/sources/.external/connection/copy';
    vi.spyOn(protection, 'plan').mockResolvedValue({
      ...initial,
      writableRoots: [...initial.writableRoots, clone],
    });
    const manager = new CodexProcessManager(
      null as never,
      null as never,
      protection,
    );
    const restart = vi.spyOn(manager, 'restartControlled').mockResolvedValue();
    await manager.ensureDocumentIsolation(clone);
    expect(restart).not.toHaveBeenCalled();
  });

  it('still detects every real document, system, quarantine and outer writable boundary change', async () => {
    const protection = service(false, 3);
    const initial = (await protection.plan())!;
    protection.accept(initial);
    for (const plan of [
      {
        ...initial,
        publishedRoots: [
          ...initial.publishedRoots,
          '/workspaces/other/livrables',
        ],
      },
      {
        ...initial,
        privateRoots: [...initial.privateRoots, '/workspaces/other-system'],
      },
      {
        ...initial,
        unavailableRoots: [
          ...initial.unavailableRoots,
          '/workspaces/broken/missing',
        ],
      },
      { ...initial, writableRoots: ['/workspaces/good'] },
      { ...initial, databasePath: initial.databasePath + '.new' },
      { ...initial, home: '/home/codex/other' },
    ])
      expect(protection.changed(plan)).toBe(true);
    expect(protection.changed(initial)).toBe(false);
  });

  it('masks the separate system space from agents and retains the read-only deliverable boundary', async () => {
    const plan = await service(false, 3).plan();
    expect(plan?.privateRoots).toContain('/workspaces/.mergeron-system');
    expect(plan?.publishedRoots).toContain('/workspaces/broken/livrables');
    expect(plan?.publishedRoots).toContain(
      '/workspaces/.mergeron-system/broken',
    );
  });

  it('quarantines the working space when its system space is unavailable instead of recreating it', async () => {
    files.missing.add('/workspaces/.mergeron-system/broken');
    const protection = service(false, 3);
    await protection.plan();
    expect(() =>
      protection.assertWorkspaceAvailable('/workspaces/broken'),
    ).toThrow('unavailable');
  });

  it('relocates an external retained source directly into its protected deliverable root', async () => {
    const protection = service(true);
    vi.spyOn(
      protection as unknown as { fileHash: (file: string) => Promise<string> },
      'fileHash',
    ).mockResolvedValue('same-hash');
    const plan = await protection.plan();
    expect(files.copy).toHaveBeenCalledWith(
      '/workspaces/broken/report.docx',
      '/workspaces/broken/livrables/l/report.docx',
      2,
    );
    expect(files.updates).toContainEqual({
      sourcePath: '/workspaces/broken/livrables/l/report.docx',
      previousSourcePaths: ['/workspaces/broken/report.docx'],
    });
    expect(plan?.publishedRoots).toContain('/workspaces/broken/livrables');
  });

  it('does not replace metadata when an occupied root destination has different content', async () => {
    const protection = service(true);
    files.copy.mockRejectedValue(
      Object.assign(new Error('exists'), { code: 'EEXIST' }),
    );
    vi.spyOn(
      protection as unknown as { fileHash: (file: string) => Promise<string> },
      'fileHash',
    ).mockImplementation((file) =>
      Promise.resolve(file.includes('/livrables/') ? 'different' : 'source'),
    );
    await expect(protection.plan()).rejects.toThrow(
      'changed during protected relocation',
    );
    expect(files.updates).toHaveLength(0);
  });

  it('masks a missing workspace without making its parent read-only or recreating it', async () => {
    files.missing.add('/workspaces/broken');
    const protection = service(false);
    const plan = await protection.plan();
    expect(plan?.unavailableRoots).toEqual(['/workspaces/broken']);
    expect(plan?.publishedRoots).not.toContain('/workspaces');
    expect(() =>
      protection.assertWorkspaceAvailable('/workspaces/good'),
    ).not.toThrow();
  });
});
