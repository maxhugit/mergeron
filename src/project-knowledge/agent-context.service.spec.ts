import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  people,
  projectParticipants,
  projects,
  projectAgentThreads,
  projectWorkspaces,
  projectWorkspaceCopies,
  projectLocations,
  personAgentInstructions,
} from '../database/schema';
import { accessContext } from '../auth/access-context';
import { IdentityService } from '../auth/identity.service';
import { WorkspaceResourcesService } from '../projects/workspace-resources.service';
import { WorkspaceGitService } from '../projects/workspace-git.service';
import { AgentInstructionsService } from '../settings/agent-instructions.service';
import { ProjectKnowledgeService } from './project-knowledge.service';
import {
  AgentContextService,
  readInstructionFiles,
} from './agent-context.service';

describe('agent instruction source and refresh receipts', () => {
  let database: TestDatabase;
  let root: string;
  let identities: IdentityService;
  let service: AgentContextService;
  let unavailable: boolean;
  const asPerson = <T>(id: string, action: () => T) =>
    accessContext.run(
      { identity: identities.resolvePerson(id), identities },
      action,
    );
  beforeEach(async () => {
    database = createTestDatabase();
    root = await mkdtemp(path.join(tmpdir(), 'agent-context-'));
    await writeFile(path.join(root, 'AGENTS.md'), 'Repository rules');
    await mkdir(path.join(root, 'web'));
    await writeFile(path.join(root, 'web/AGENTS.md'), 'Frontend rules');
    database.db
      .insert(people)
      .values(
        ['admin', 'other'].map((id) => ({
          id,
          reference: id,
          name: id,
          role: 'administrator' as const,
          createdAt: 1,
          updatedAt: 1,
        })),
      )
      .run();
    database.db
      .insert(projects)
      .values({
        id: 'p',
        name: 'Project',
        workspacePath: root,
        createdAt: 1,
        updatedAt: 1,
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
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'agent',
        projectId: 'p',
        workspacePath: '/livrable',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(projectWorkspaceCopies)
      .values({
        id: 'copy',
        projectId: 'p',
        sourceResourceId: 'source',
        localWorkspaceId: 'w',
        name: 'Copy',
        revision: 'a',
        state: 'ready',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    identities = new IdentityService(database.db);
    unavailable = false;
    service = new AgentContextService(database.db, {
      get: (key: unknown) => {
        if (key === WorkspaceResourcesService)
          return {
            get: () => ({
              enabled: true,
              type: 'git',
              capabilities: { read: true },
            }),
          };
        if (key === WorkspaceGitService)
          return {
            directory: (project: string, copy: string) => {
              if (unavailable || project !== 'p' || copy !== 'copy')
                throw Error('Copy unavailable');
              return Promise.resolve(root);
            },
            git: () => Promise.resolve('a'.repeat(40)),
          };
        if (key === AgentInstructionsService)
          return { context: () => 'Server rules' };
        if (key === ProjectKnowledgeService)
          return { contextForProject: () => Promise.resolve('Project rules') };
        throw Error('Unknown provider');
      },
    } as unknown as ModuleRef);
  });
  afterEach(async () => {
    database.sqlite.close();
    await rm(root, { recursive: true, force: true });
  });

  it('associates independently of cwd, refuses stale writes and reads scoped files on demand', async () => {
    await asPerson('admin', () =>
      service.associate('agent', { copyId: 'copy', version: 0 }),
    );
    expect(
      database.db.select().from(projectAgentThreads).get()?.workspacePath,
    ).toBe('/livrable');
    await expect(
      asPerson('admin', () =>
        service.associate('agent', { copyId: null, version: 0 }),
      ),
    ).rejects.toThrow('reload');
    const first = await asPerson('admin', () =>
      service.prepare('agent', 'turn'),
    );
    expect(first.context).toContain('Repository rules');
    expect(first.context).not.toContain('Frontend rules');
    const scoped = await asPerson('admin', () =>
      service.prepare('agent', 'mcp', 'web'),
    );
    expect(scoped.context).toContain('Frontend rules');
    expect(
      scoped.sources.find((source) => source.kind === 'git')?.files,
    ).toEqual(['AGENTS.md', 'web/AGENTS.md']);
    await expect(
      asPerson('admin', () =>
        service.associate('agent', { copyId: 'foreign-copy', version: 1 }),
      ),
    ).rejects.toThrow('unavailable');
    expect(asPerson('admin', () => service.status('agent')).copyId).toBe(
      'copy',
    );
  });

  it('distinguishes verification from supply and invalidates after compaction without claiming delivery', async () => {
    const first = await asPerson('admin', () =>
      service.prepare('agent', 'turn'),
    );
    expect(
      asPerson('admin', () => service.status('agent')).events[0].state,
    ).toBe('verified');
    asPerson('admin', () => service.supplied(first, 'turn'));
    expect(
      asPerson('admin', () => service.status('agent')).events[0].state,
    ).toBe('supplied');
    service.invalidated('agent', 'compaction');
    expect(
      asPerson('admin', () => service.status('agent')).events[0],
    ).toMatchObject({ state: 'pending', trigger: 'compaction' });
    const next = await asPerson('admin', () => service.prepare('agent', 'mcp'));
    expect(next.revision).toBe(first.revision);
    asPerson('admin', () => service.supplied(next, 'mcp'));
    expect(
      asPerson('admin', () => service.status('agent')).events[0].state,
    ).toBe('supplied');
  });

  it('detects uncommitted changes and fails closed when an associated source disappears', async () => {
    await asPerson('admin', () =>
      service.associate('agent', { copyId: 'copy', version: 0 }),
    );
    const first = await asPerson('admin', () =>
      service.prepare('agent', 'turn'),
    );
    await writeFile(path.join(root, 'AGENTS.md'), 'Changed locally');
    const next = await asPerson('admin', () =>
      service.prepare('agent', 'turn'),
    );
    expect(next.revision).not.toBe(first.revision);
    expect(next.sources[3].commit).toBe(first.sources[3].commit);
    unavailable = true;
    await expect(
      asPerson('admin', () => service.prepare('agent', 'turn')),
    ).rejects.toThrow('unavailable');
    expect(
      asPerson('admin', () => service.status('agent')).events[0].state,
    ).toBe('unavailable');
    await asPerson('admin', () =>
      service.associate('agent', { copyId: null, version: 1 }),
    );
    expect(
      (await asPerson('admin', () => service.prepare('agent', 'turn'))).context,
    ).not.toContain('Changed locally');
  });

  it('uses the authenticated requester preferences, clears empty values, and never journals their content', async () => {
    asPerson('admin', () =>
      service.profile({
        personId: 'admin',
        instructions: 'My personal preference',
        language: 'fr',
      }),
    );
    const first = await asPerson('admin', () =>
      service.prepare('agent', 'turn'),
    );
    expect(first.context).toContain('My personal preference');
    expect(
      (await asPerson('other', () => service.prepare('agent', 'turn'))).context,
    ).not.toContain('My personal preference');
    expect(
      JSON.stringify(asPerson('admin', () => service.status('agent'))),
    ).not.toContain('My personal preference');
    expect(() =>
      asPerson('other', () =>
        service.profile({
          personId: 'admin',
          instructions: 'Overwrite',
          language: 'en',
        }),
      ),
    ).toThrow();
    asPerson('admin', () =>
      service.profile({
        personId: 'admin',
        instructions: '',
        language: 'message',
      }),
    );
    expect(
      (await asPerson('admin', () => service.prepare('agent', 'turn'))).context,
    ).not.toContain('My personal preference');
    database.db.delete(people).where(eq(people.id, 'admin')).run();
    expect(
      database.db.select().from(personAgentInstructions).all(),
    ).toHaveLength(0);
  });

  it('refuses unauthenticated calls and does not acknowledge a changed association', async () => {
    expect(() => service.status('agent')).toThrow('Authenticated');
    const snapshot = await asPerson('admin', () =>
      service.prepare('agent', 'turn'),
    );
    await asPerson('admin', () =>
      service.associate('agent', { copyId: 'copy', version: 0 }),
    );
    expect(asPerson('admin', () => service.supplied(snapshot, 'turn'))).toBe(
      false,
    );
  });

  it('refuses a revoked read capability even for an administrator', async () => {
    await asPerson('admin', () =>
      service.associate('agent', { copyId: 'copy', version: 0 }),
    );
    database.db
      .update(projectLocations)
      .set({ capabilities: { read: false, write: false, execute: false } })
      .where(eq(projectLocations.localWorkspaceId, 'w'))
      .run();
    await expect(
      asPerson('admin', () => service.prepare('agent', 'turn')),
    ).rejects.toThrow('unavailable');
  });

  it('allows personal preferences but requires project access and administrator authority for associations', async () => {
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
    expect(() => asPerson('reader', () => service.status('agent'))).toThrow();
    database.db
      .insert(projectParticipants)
      .values({ projectId: 'p', personId: 'reader', createdAt: 1 })
      .run();
    expect(asPerson('reader', () => service.status('agent')).copyId).toBeNull();
    asPerson('reader', () =>
      service.profile({
        personId: 'reader',
        instructions: 'My preference',
        language: 'en',
      }),
    );
    await expect(
      asPerson('reader', () =>
        service.associate('agent', { copyId: 'copy', version: 0 }),
      ),
    ).rejects.toThrow();
  });

  it('bounds the journal and removes metadata when the agent is deleted', () => {
    for (let i = 0; i < 60; i++) service.invalidated('agent', 'compaction');
    expect(
      database.sqlite
        .prepare('SELECT count(*) as n FROM agent_context_events')
        .get(),
    ).toEqual({ n: 50 });
    database.db
      .delete(projectAgentThreads)
      .where(eq(projectAgentThreads.threadId, 'agent'))
      .run();
    expect(
      database.sqlite
        .prepare('SELECT count(*) as n FROM agent_context_events')
        .get(),
    ).toEqual({ n: 0 });
  });

  it('rejects traversal, symlink and hardlink files, aggregate overflows and missing roots', async () => {
    await expect(readInstructionFiles(root, '../outside')).rejects.toThrow(
      'Invalid',
    );
    await symlink(root, path.join(root, 'escape'));
    await expect(readInstructionFiles(root, 'escape')).rejects.toThrow();
    await rm(path.join(root, 'web/AGENTS.md'));
    await symlink(
      path.join(root, 'AGENTS.md'),
      path.join(root, 'web/AGENTS.md'),
    );
    await expect(readInstructionFiles(root, 'web')).rejects.toThrow();
    await rm(path.join(root, 'web/AGENTS.md'));
    await link(path.join(root, 'AGENTS.md'), path.join(root, 'web/AGENTS.md'));
    await expect(readInstructionFiles(root)).rejects.toThrow('Unsafe');
    await rm(path.join(root, 'web/AGENTS.md'));
    await writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(20000));
    await writeFile(path.join(root, 'web/AGENTS.md'), 'y'.repeat(20000));
    await expect(readInstructionFiles(root, 'web')).rejects.toThrow('32 KiB');
    await rm(path.join(root, 'AGENTS.md'));
    await expect(readInstructionFiles(root)).rejects.toThrow('missing');
  });

  it('rejects invalid UTF-8 instead of silently replacing instruction bytes', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), Buffer.from([0xff, 0xfe]));
    await expect(readInstructionFiles(root)).rejects.toThrow();
  });

  it('honors override precedence without loading both files in the same directory', async () => {
    await writeFile(path.join(root, 'AGENTS.override.md'), 'Override rules');
    const files = await readInstructionFiles(root);
    expect(files).toEqual([
      { path: 'AGENTS.override.md', text: 'Override rules' },
    ]);
  });
});
