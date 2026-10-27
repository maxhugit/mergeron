import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projects,
  projectWorkspaces,
  projectAgentThreads,
} from '../database/schema';
import { ProjectWorkspaceLayout } from '../projects/project-workspace-layout';
import { projectSystemPath } from '../projects/workspace-structure';
import { ProjectKnowledgeService } from './project-knowledge.service';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

describe('shared project knowledge', () => {
  let database: TestDatabase;
  let root: string;
  let directory: string;
  let service: ProjectKnowledgeService;
  beforeEach(async () => {
    database = createTestDatabase();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-knowledge-'));
    const primary = await new ProjectWorkspaceLayout(database.db, root).prepare(
      'p',
    );
    directory = path.join(projectSystemPath(primary), 'knowledge');
    database.db
      .insert(projects)
      .values({
        id: 'p',
        name: 'Project',
        workspacePath: primary,
        workspaceLayoutVersion: 3,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(projectWorkspaces)
      .values([
        {
          id: 'primary',
          projectId: 'p',
          name: 'Principal',
          path: primary,
          primary: true,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'secondary',
          projectId: 'p',
          name: 'Secondary',
          path: path.join(root, 'secondary'),
          primary: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      .run();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'agent',
        projectId: 'p',
        workspacePath: path.join(root, 'secondary'),
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    service = new ProjectKnowledgeService(database.db);
  });
  afterEach(async () => {
    database.sqlite.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('saves all documents and rejects a stale revision without losing another edit', async () => {
    const original = await service.read('p');
    const updated = await service.save('p', {
      revision: original.revision,
      files: {
        ...original.files,
        'DECISIONS.md': 'Use the immutable project ID.',
      },
    });
    expect(updated.revision).not.toBe(original.revision);
    await expect(service.save('p', original)).rejects.toThrow('changed since');
    expect((await service.read('p')).files['DECISIONS.md']).toBe(
      'Use the immutable project ID.',
    );
  });

  it('serializes simultaneous editor saves, with only one accepted revision', async () => {
    const original = await service.read('p');
    const results = await Promise.allSettled(
      ['First', 'Second'].map((content) =>
        service.save('p', {
          revision: original.revision,
          files: { ...original.files, 'AGENTS.md': content },
        }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect((await service.read('p')).files['AGENTS.md']).toBe('First');
  });

  it('uses the principal files for secondary conversations and reloads changes each time', async () => {
    const before = await service.contextForConversation(
      path.join(root, 'secondary'),
    );
    expect(before).toContain('Connaissances du projet');
    await fs.writeFile(
      path.join(directory, 'CONNAISSANCES.md'),
      'A newly saved fact',
    );
    expect(
      await service.contextForConversation(path.join(root, 'secondary')),
    ).toContain('A newly saved fact');
    expect(
      await service.contextForConversation('/different-cwd', 'agent'),
    ).toContain('A newly saved fact');
    expect(await service.contextForConversation('/unrelated')).toBeNull();
  });

  it('does not leak knowledge from a different project', async () => {
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
    await new ProjectWorkspaceLayout(database.db, root).prepare('other');
    await fs.writeFile(
      path.join(
        projectSystemPath(path.join(root, 'other')),
        'knowledge/AGENTS.md',
      ),
      'Private to other project',
    );
    expect(
      await service.contextForConversation(path.join(root, 'secondary')),
    ).not.toContain('Private to other project');
  });

  it('keeps an empty snapshot authoritative when knowledge is cleared', async () => {
    const original = await service.read('p');
    await service.save('p', {
      revision: original.revision,
      files: { 'AGENTS.md': '', 'CONNAISSANCES.md': '', 'DECISIONS.md': '' },
    });
    const context = await service.contextForProject('p');
    expect(context).toContain('empty section removes its previous content');
    expect(context).toContain('AGENTS.md:\n""');
  });

  it('rejects traversal keys, oversized UTF-8 text and symbolic links', async () => {
    const original = await service.read('p');
    await expect(
      service.save('p', {
        revision: original.revision,
        files: { ...original.files, '../secret': 'x' },
      } as never),
    ).rejects.toThrow('three knowledge files');
    await expect(
      service.save('p', {
        revision: original.revision,
        files: { ...original.files, 'AGENTS.md': 'é'.repeat(20000) },
      }),
    ).rejects.toThrow('32768');
    await fs.unlink(path.join(directory, 'AGENTS.md'));
    await fs.writeFile(path.join(root, 'outside.md'), 'Do not overwrite');
    await fs.symlink(
      path.join(root, 'outside.md'),
      path.join(directory, 'AGENTS.md'),
    );
    await expect(service.read('p')).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'outside.md'), 'utf8')).toBe(
      'Do not overwrite',
    );
  });

  it('can recreate a missing document through the dedicated editor', async () => {
    await fs.unlink(path.join(directory, 'DECISIONS.md'));
    const original = await service.read('p');
    expect(original.files['DECISIONS.md']).toBe('');
    await service.save('p', {
      revision: original.revision,
      files: { ...original.files, 'DECISIONS.md': 'Restored' },
    });
    expect(
      await fs.readFile(path.join(directory, 'DECISIONS.md'), 'utf8'),
    ).toBe('Restored');
  });

  it('restores earlier contents if replacing the second file fails', async () => {
    const original = await service.read('p');
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(fs.rename)
      .mockImplementationOnce(actual.rename)
      .mockRejectedValueOnce(new Error('Disk write failed'));
    await expect(
      service.save('p', {
        revision: original.revision,
        files: {
          'AGENTS.md': 'New rules',
          'CONNAISSANCES.md': 'New facts',
          'DECISIONS.md': 'New decisions',
        },
      }),
    ).rejects.toThrow('Disk write failed');
    expect((await service.read('p')).files).toEqual(original.files);
    expect((await fs.readdir(directory)).sort()).toEqual([
      'AGENTS.md',
      'CONNAISSANCES.md',
      'DECISIONS.md',
    ]);
    await expect(service.save('p', original)).resolves.toMatchObject({
      files: original.files,
    });
  });
});
