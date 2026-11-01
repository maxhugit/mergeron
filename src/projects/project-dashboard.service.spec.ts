import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projects,
  projectResources,
  projectTaskStatuses,
  projectTasks,
  people,
  projectParticipants,
} from '../database/schema';
import { accessContext } from '../auth/access-context';
import { IdentityService } from '../auth/identity.service';
import { ProjectsService } from './projects.service';

let database: TestDatabase;
beforeEach(() => {
  database = createTestDatabase();
});
afterEach(() => {
  vi.restoreAllMocks();
  database.sqlite.close();
});

it.each([10, 1000])(
  'keeps dashboard reads constant for %i tasks and rechecks project access',
  async (count) => {
    for (const id of ['visible', 'private']) {
      database.db
        .insert(projects)
        .values({
          id,
          name: id,
          workspacePath: `/test/${id}`,
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      database.db
        .insert(projectResources)
        .values({
          id,
          projectId: id,
          type: 'task_board',
          name: id,
          config: {},
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      database.db
        .insert(projectTaskStatuses)
        .values({
          id,
          resourceId: id,
          name: 'Open',
          color: 'slate',
          kind: 'unassigned',
          position: 0,
          system: true,
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      for (let index = 0; index < count; index++)
        database.db
          .insert(projectTasks)
          .values({
            id: `${id}-${index}`,
            resourceId: id,
            statusId: id,
            title: `${id}-${index}`,
            position: index,
            createdAt: 1,
            updatedAt: 1,
          })
          .run();
    }
    const service = new ProjectsService(
      null as never,
      null as never,
      { read: () => Promise.resolve({ entries: [] }) } as never,
      null as never,
      null as never,
      null as never,
      null as never,
      database.db,
    );
    const prepare = vi.spyOn(database.sqlite, 'prepare');
    const run = (allowed: string) =>
      accessContext.run(
        {
          identity: {} as never,
          identities: {
            canReadProject: (_identity: unknown, id: string) => id === allowed,
          } as never,
        },
        () => service.dashboard(),
      );
    const visible = await run('visible');
    expect(visible.projects.map((project) => project.id)).toEqual(['visible']);
    expect(visible.totals.openTasks).toBe(count);
    expect(
      prepare.mock.calls.filter(([sql]) => /^select /i.test(sql)),
    ).toHaveLength(6);
    prepare.mockClear();
    const privateResult = await run('private');
    expect(privateResult.projects.map((project) => project.id)).toEqual([
      'private',
    ]);
    expect(privateResult.totals.openTasks).toBe(count);
    expect(
      prepare.mock.calls.filter(([sql]) => /^select /i.test(sql)),
    ).toHaveLength(6);

    // Also exercise the real policy: a retained identity must not retain a
    // membership after revocation, including while metadata is being awaited.
    database.db
      .insert(people)
      .values({
        id: 'viewer',
        reference: 'viewer',
        name: 'Viewer',
        firstName: 'Viewer',
        lastName: 'Fixture',
        email: 'viewer@example.invalid',
        role: 'standard',
        active: true,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const identities = new IdentityService(database.db);
    const identity = identities.resolvePerson('viewer');
    const realRun = () =>
      accessContext.run({ identity, identities }, () => service.dashboard());
    database.db
      .insert(projectParticipants)
      .values({ personId: 'viewer', projectId: 'visible', createdAt: 1 })
      .run();
    expect((await realRun()).projects.map((project) => project.id)).toEqual([
      'visible',
    ]);
    database.db.delete(projectParticipants).run();
    database.db
      .insert(projectParticipants)
      .values({ personId: 'viewer', projectId: 'private', createdAt: 1 })
      .run();
    expect((await realRun()).projects.map((project) => project.id)).toEqual([
      'private',
    ]);
    const pending = realRun();
    database.db.delete(projectParticipants).run();
    expect((await pending).projects).toEqual([]);
  },
);
