import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  people,
  projects,
  projectParticipants,
  settings,
} from '../database/schema';
import { IdentityService } from './identity.service';
import {
  ProjectExplorerPreferencesService,
  ProjectExplorerPreferencesController,
} from './project-explorer-preferences';

let database: TestDatabase,
  identities: IdentityService,
  service: ProjectExplorerPreferencesService;
beforeEach(() => {
  database = createTestDatabase();
  database.db
    .insert(people)
    .values([
      {
        id: 'alice',
        reference: 'alice',
        name: 'Alice',
        role: 'administrator',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'bob',
        reference: 'bob',
        name: 'Bob',
        role: 'standard',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    .run();
  database.db
    .insert(projects)
    .values(
      ['p', 'q'].map((id) => ({
        id,
        name: id,
        workspacePath: '/' + id,
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  database.db
    .insert(projectParticipants)
    .values({ projectId: 'p', personId: 'bob', createdAt: 1 })
    .run();
  identities = new IdentityService(database.db);
  service = new ProjectExplorerPreferencesService(database.db, identities);
});
afterEach(() => database.sqlite.close());

it('persists a personal project choice without requiring any agent and isolates other people/projects', () => {
  const alice = identities.resolvePerson('alice'),
    bob = identities.resolvePerson('bob');
  expect(service.preference(alice, 'p').tab).toBe('folders');
  expect(
    service.preference(alice, 'p', { personId: 'alice', tab: 'deliverables' }),
  ).toEqual({ personId: 'alice', projectId: 'p', tab: 'deliverables' });
  expect(
    new ProjectExplorerPreferencesService(
      database.db,
      new IdentityService(database.db),
    ).preference(alice, 'p').tab,
  ).toBe('deliverables');
  expect(service.preference(alice, 'q').tab).toBe('folders');
  expect(service.preference(bob, 'p').tab).toBe('folders');
  service.preference(bob, 'p', { personId: 'bob', tab: 'sources' });
  expect(service.preference(alice, 'p').tab).toBe('deliverables');
});

it('preserves a valid choice even when its manager is not currently present', () => {
  const alice = identities.resolvePerson('alice');
  service.preference(alice, 'p', { personId: 'alice', tab: 'tasks' });
  expect(service.preference(alice, 'p').tab).toBe('tasks');
});

it('refuses inaccessible projects, inactive profiles, anonymous callers and another person ID', () => {
  const alice = identities.resolvePerson('alice'),
    bob = identities.resolvePerson('bob');
  expect(() => service.preference(bob, 'q')).toThrow(ForbiddenException);
  expect(() =>
    service.preference(bob, 'q', { personId: 'bob', tab: 'sources' }),
  ).toThrow(ForbiddenException);
  expect(() =>
    service.preference(alice, 'p', { personId: 'bob', tab: 'sources' }),
  ).toThrow(ForbiddenException);
  expect(() => service.preference(undefined, 'p')).toThrow(ForbiddenException);
  expect(() => service.preference(alice, 'missing')).toThrow(NotFoundException);
  database.db
    .update(people)
    .set({ active: false })
    .where(eq(people.id, 'alice'))
    .run();
  expect(() => service.preference(alice, 'p')).toThrow(ForbiddenException);
});

it.each([undefined, null, '', 'other', 'folders ', {}, ['folders'], true])(
  'rejects an invalid tab %j',
  (tab) => {
    expect(() =>
      service.preference(identities.resolvePerson('alice'), 'p', {
        personId: 'alice',
        tab,
      }),
    ).toThrow(BadRequestException);
    expect(database.db.select().from(settings).all()).toHaveLength(0);
  },
);

it('falls back safely for corrupt persisted presentation data', () => {
  const alice = identities.resolvePerson('alice');
  service.preference(alice, 'p', { personId: 'alice', tab: 'sources' });
  database.db.update(settings).set({ value: '{invalid' }).run();
  expect(service.preference(alice, 'p').tab).toBe('folders');
});

it('does not interpret a missing PATCH body as a read', () => {
  const controller = new ProjectExplorerPreferencesController(service);
  expect(() =>
    controller.save(
      'p',
      { platformIdentity: identities.resolvePerson('alice') } as never,
      null,
    ),
  ).toThrow(BadRequestException);
});
