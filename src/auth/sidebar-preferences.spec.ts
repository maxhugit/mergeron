import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { people, projects, projectAgentThreads } from '../database/schema';
import { IdentityService } from './identity.service';
let database: TestDatabase, service: IdentityService;
beforeEach(() => {
  database = createTestDatabase();
  database.db
    .insert(people)
    .values(
      ['alice', 'bob'].map((id) => ({
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
      name: 'P',
      workspacePath: '/p',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(projectAgentThreads)
    .values(
      ['agent-a', 'agent-b'].map((threadId) => ({
        threadId,
        projectId: 'p',
        workspacePath: '/p',
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  service = new IdentityService(database.db);
});
afterEach(() => database.sqlite.close());
it('isolates right sidebar state by person and agent, while projects use person only', () => {
  const alice = service.resolvePerson('alice'),
    bob = service.resolvePerson('bob');
  service.sidebarPreferences(alice, 'agent-a', {
    key: 'open:task:one',
    value: true,
  });
  expect(service.sidebarPreferences(alice, 'agent-a').values).toEqual({
    'open:task:one': true,
  });
  expect(service.sidebarPreferences(alice, 'agent-b').values).toEqual({});
  expect(service.sidebarPreferences(bob, 'agent-a').values).toEqual({});
  service.sidebarPreferences(alice, 'projects', {
    key: 'open:project:%2Fp',
    value: false,
  });
  expect(service.sidebarPreferences(alice, 'projects').values).toEqual({
    'open:project:%2Fp': false,
  });
  expect(service.sidebarPreferences(bob, 'projects').values).toEqual({});
  expect(
    new IdentityService(database.db).sidebarPreferences(alice, 'agent-a')
      .values,
  ).toEqual({ 'open:task:one': true });
});
it('rejects unknown agents, invalid values and project keys in an agent scope', () => {
  const alice = service.resolvePerson('alice');
  expect(() => service.sidebarPreferences(alice, 'missing')).toThrow();
  for (const [scope, key, value] of [
    ['projects', 'mode:tasks', 'plain'],
    ['agent-a', 'open:project:p', true],
    ['agent-a', 'open:task:a', 'true'],
    ['agent-a', 'mode:tasks', 'other'],
  ] as const)
    expect(() =>
      service.sidebarPreferences(alice, scope, { key, value }),
    ).toThrow();
  expect(() => service.sidebarPreferences(undefined, 'projects')).toThrow();
});
