import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { AppDatabase } from '../database/database.constants';
import { ThreadResponseDetailService } from './thread-response-detail.service';
import { ThreadResponseDetailController } from './thread-response-detail.controller';
import type { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { accessContext } from '../auth/access-context';
import type {
  IdentityService,
  PlatformIdentity,
} from '../auth/identity.service';

function storage() {
  const rows = new Map<string, { value: string }>();
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: Parameters<SQLiteSyncDialect['sqlToQuery']>[0]) => ({
          get: () =>
            rows.get(
              String(new SQLiteSyncDialect().sqlToQuery(condition).params[0]),
            ),
        }),
      }),
    }),
    insert: () => ({
      values: (row: { key: string; value: string }) => ({
        onConflictDoUpdate: () => ({ run: () => rows.set(row.key, row) }),
      }),
    }),
  } as unknown as AppDatabase;
  return { db, rows };
}

it('defaults to collapsed and persists distinct preferences across service instances', () => {
  const { db } = storage();
  const service = new ThreadResponseDetailService(db);
  expect(service.read('a')).toEqual({ mode: 'collapsed' });
  service.set('a', 'hidden');
  service.set('b', 'expanded');
  const restarted = new ThreadResponseDetailService(db);
  expect(restarted.read('a').mode).toBe('hidden');
  expect(restarted.read('b').mode).toBe('expanded');
  restarted.set('a', 'collapsed');
  expect(restarted.read('b').mode).toBe('expanded');
});

it('validates all three modes and refuses deletion or unauthorized access', () => {
  const { db } = storage();
  const service = new ThreadResponseDetailService(db);
  const deletion = { assertMutable: vi.fn() };
  const controller = new ThreadResponseDetailController(
    service,
    deletion as unknown as ThreadDeletionRegistryService,
  );
  for (const mode of ['hidden', 'collapsed', 'expanded']) {
    expect(controller.set('a', { mode })).toEqual({ mode });
  }
  for (const mode of [null, undefined, '', 'high', 4, {}]) {
    expect(() => controller.set('a', { mode })).toThrow('Choose');
  }
  deletion.assertMutable.mockImplementation(() => {
    throw new Error('Deleted');
  });
  expect(() => controller.set('a', { mode: 'hidden' })).toThrow('Deleted');
  const identities = {
    requireThread: vi.fn(() => {
      throw new Error('Forbidden');
    }),
    requireAdministrator: vi.fn(),
  };
  accessContext.run(
    {
      identity: {} as PlatformIdentity,
      identities: identities as unknown as IdentityService,
    },
    () => {
      expect(() => controller.read('a')).toThrow('Forbidden');
      expect(() => controller.set('a', { mode: 'hidden' })).toThrow(
        'Forbidden',
      );
    },
  );
  expect(service.read('a').mode).toBe('expanded');
});

it('allows authorized reads but refuses changes without execution rights', () => {
  const { db } = storage();
  const service = new ThreadResponseDetailService(db);
  const controller = new ThreadResponseDetailController(service, {
    assertMutable: vi.fn(),
  } as unknown as ThreadDeletionRegistryService);
  const identities = {
    requireThread: vi.fn(),
    requireAdministrator: vi.fn(() => {
      throw new Error('Administrator required');
    }),
  };
  accessContext.run(
    {
      identity: {} as PlatformIdentity,
      identities: identities as unknown as IdentityService,
    },
    () => {
      expect(controller.read('a')).toEqual({ mode: 'collapsed' });
      expect(() => controller.set('a', { mode: 'expanded' })).toThrow(
        'Administrator required',
      );
    },
  );
  expect(service.read('a')).toEqual({ mode: 'collapsed' });
});
