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

const files = vi.hoisted(() => ({ missing: new Set<string>() }));
vi.mock('node:fs/promises', () => {
  const check = (target: string) => {
    if (files.missing.has(target))
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    return Promise.resolve(target);
  };
  return {
    constants: { X_OK: 1 },
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
    vi.stubEnv('MERGERON_PUBLISHED_DOCUMENT_PROTECTION', 'required');
    vi.stubGlobal('process', { ...process, platform: 'linux' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function service(missingDocument: boolean) {
    const project = {
      id: 'broken',
      workspaceLayoutVersion: 1,
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
                  sourcePath: '/workspaces/broken/report.docx',
                },
              },
            ]
          : [],
      ],
      [projectDeliverableDocumentVersions, []],
    ]);
    const db = {
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
