import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { projects, projectAgentThreads } from '../database/schema';
import { ProjectsService } from './projects.service';

let database: TestDatabase;
beforeEach(() => {
  database = createTestDatabase();
});
afterEach(() => database.sqlite.close());
it('projects archive metadata only for archived agents, without inventing legacy attribution', async () => {
  database.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'P',
      workspacePath: '/p',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(projectAgentThreads)
    .values(
      ['archived', 'legacy', 'live'].map((threadId) => ({
        threadId,
        projectId: 'p',
        workspacePath: '/p',
        createdAt: 1,
        updatedAt: 1,
        ...(threadId === 'legacy'
          ? {}
          : {
              archivedAt: 1234,
              archivedByPersonId: 'person',
              archivedByName: 'Historical name',
              archivedByType: 'person' as const,
            }),
      })),
    )
    .run();
  const service = Object.create(ProjectsService.prototype) as ProjectsService;
  Object.assign(service, {
    db: database.db,
    ensurePrimaryWorkspaces: vi.fn().mockResolvedValue(undefined),
    metadata: {
      read: () =>
        Promise.resolve({
          entries: ['archived', 'legacy', 'live'].map((id) => ({
            thread: { id, name: id, preview: '' },
            archived: id !== 'live',
          })),
        }),
    },
    overrides: { applyToThreads: (threads: unknown[]) => threads },
    activeFolders: { get: () => null },
  });
  const agents = (await service.list())[0].agentThreads;
  expect(agents.find((agent) => agent.threadId === 'archived')).toMatchObject({
    archivedAt: 1234,
    archivedByPersonId: 'person',
    archivedByName: 'Historical name',
  });
  expect(agents.find((agent) => agent.threadId === 'legacy')).toMatchObject({
    archivedAt: null,
    archivedByPersonId: null,
    archivedByName: null,
  });
  expect(agents.find((agent) => agent.threadId === 'live')).toMatchObject({
    archivedAt: null,
    archivedByPersonId: null,
    archivedByName: null,
  });
});
