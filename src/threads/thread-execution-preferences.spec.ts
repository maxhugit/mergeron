import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { accessContext } from '../auth/access-context';
import type {
  IdentityService,
  PlatformIdentity,
} from '../auth/identity.service';
import type { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import type {
  ThreadSecurityPolicyDto,
  PatchThreadSecurityPolicyDto,
} from './dto/thread-security-policy.dto';
import { ThreadExecutionPreferencesController } from './thread-execution-preferences.controller';
import { ThreadExecutionPreferencesService } from './thread-execution-preferences.service';
import { ThreadSecurityPolicyController } from './thread-security-policy.controller';
import { ThreadSettingsObserverService } from './thread-settings-observer.service';
import type { v2 } from '../codex/codex-schema';
import { boundedApprovalPolicy } from './agent-approval-policy';

let storage: TestDatabase;
let service: ThreadExecutionPreferencesService;
const policy: PatchThreadSecurityPolicyDto = {
  approvalPolicy: 'on-request',
  sandboxPolicy: {
    type: 'workspaceWrite',
    writableRoots: ['/extra'],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  },
};
function observed(patch = policy): ThreadSecurityPolicyDto {
  return {
    observed: true,
    source: 'notification',
    approvalPolicy: null,
    sandboxPolicy: null,
    approvalsReviewer: null,
    ...patch,
  };
}
beforeEach(() => {
  storage = createTestDatabase();
  service = new ThreadExecutionPreferencesService(storage.db);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  storage.sqlite.close();
});

it('persists shared per-agent choices across service restarts and keeps other agents independent', () => {
  service.set('a', {
    model: 'model-a',
    effort: 'high',
    serviceTier: 'priority',
  });
  service.set('b', { model: 'model-b', effort: 'low' });
  const restarted = new ThreadExecutionPreferencesService(storage.db);
  expect(restarted.forTurn('a')).toEqual({
    model: 'model-a',
    effort: 'high',
    serviceTier: 'priority',
  });
  expect(restarted.forTurn('b')).toEqual({
    model: 'model-b',
    effort: 'low',
    serviceTier: null,
  });
  expect(restarted.forTurn('never-selected')).toEqual({});
  const before = restarted.read('a').revision;
  expect(restarted.set('a', { serviceTier: null }).revision).toBeGreaterThan(
    before,
  );
  expect(restarted.forTurn('a').serviceTier).toBeNull();
  restarted.set('a', { model: null });
  expect(restarted.forTurn('a')).toEqual({
    model: null,
    effort: null,
    serviceTier: null,
  });
});

it.each([
  null,
  [],
  {},
  { userId: 'person' },
  { effort: 'unknown' },
  { model: '' },
  { model: 'x'.repeat(201) },
  { security: policy },
  { approvalPolicy: 'never' },
])(
  'rejects invalid choices and never exposes a direct permission-persistence bypass: %j',
  (input) => {
    expect(() => service.set('a', input)).toThrow();
    expect(service.read('a').revision).toBe(0);
  },
);

it.each(['notification-first', 'ack-first'])(
  'requires both RPC success and effective confirmation (%s)',
  (order) => {
    const selection = service.beginSecurity('a', policy, '/cwd', observed({}));
    if (order === 'notification-first')
      service.observeSecurity('a', observed());
    else selection.accept();
    expect(service.read('a')).toMatchObject({
      revision: 0,
      securitySaveState: 'pending',
    });
    expect(() => service.forTurn('a')).toThrow('awaiting confirmation');
    if (order === 'notification-first') selection.accept();
    else service.observeSecurity('a', observed());
    expect(service.read('a')).toMatchObject({
      security: policy,
      securitySaveState: null,
    });
    expect(
      new ThreadExecutionPreferencesService(storage.db).forTurn('a'),
    ).toEqual(policy);
  },
);

it('persists an explicit no-op only after its RPC succeeds, not on passive observations', () => {
  service.observeSecurity('a', observed());
  expect(service.read('a').revision).toBe(0);
  const selection = service.beginSecurity('a', policy, '/cwd', observed());
  expect(service.read('a').revision).toBe(0);
  selection.accept();
  expect(service.forTurn('a')).toEqual(policy);
});

it('compares every security leaf while normalizing implicit cwd and duplicate roots', () => {
  const selection = service.beginSecurity('a', policy, '/cwd', observed({}));
  selection.accept();
  service.observeSecurity(
    'a',
    observed({
      ...policy,
      sandboxPolicy: {
        ...policy.sandboxPolicy!,
        type: 'workspaceWrite',
        writableRoots: ['/extra'],
        networkAccess: true,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    }),
  );
  expect(service.read('a').security).toBeUndefined();
  service.observeSecurity(
    'a',
    observed({
      ...policy,
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/cwd', '/extra', '/extra'],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    }),
  );
  expect(service.forTurn('a')).toEqual(policy);
});

it('rejects stale, cancelled and superseded selections without overwriting previous choices', () => {
  const first = service.beginSecurity('a', policy, '/cwd', observed());
  const second = service.beginSecurity(
    'a',
    { approvalPolicy: 'never' },
    '/cwd',
    observed(),
  );
  first.accept();
  second.cancel();
  service.observeSecurity('a', observed({ approvalPolicy: 'never' }));
  expect(service.read('a').revision).toBe(0);
  const third = service.beginSecurity('a', policy, '/cwd', observed());
  service.clearPending();
  third.accept();
  expect(service.read('a').revision).toBe(0);
});

it('fails closed when a selection expires even if nobody polled its status', () => {
  vi.useFakeTimers();
  service.beginSecurity('a', policy, '/cwd', observed({})).accept();
  vi.advanceTimersByTime(8001);
  expect(() => service.forTurn('a')).toThrow('could not be saved');
  expect(service.read('a').securitySaveState).toBe('failed');
  service.observeSecurity('a', observed());
  expect(service.read('a').revision).toBe(0);
  service.beginSecurity('a', policy, '/cwd', observed()).accept();
  expect(service.forTurn('a')).toEqual(policy);
});

it('does not report a failed database write as saved and blocks dispatch until reviewed', () => {
  service.set('a', { effort: 'low' });
  const selection = service.beginSecurity('a', policy, '/cwd', observed());
  const write = vi.spyOn(storage.db, 'transaction').mockImplementation(() => {
    throw new Error('Disk full');
  });
  selection.accept();
  expect(service.read('a')).toMatchObject({
    effort: 'low',
    securitySaveState: 'failed',
  });
  expect(service.read('a').security).toBeUndefined();
  expect(() => service.forTurn('a')).toThrow('could not be saved');
  write.mockRestore();
});

it('clears durable choices only when the agent is forgotten', () => {
  service.set('a', { effort: 'high' });
  service.clearPending();
  expect(service.read('a').effort).toBe('high');
  service.forget('a');
  expect(
    new ThreadExecutionPreferencesService(storage.db).read('a').revision,
  ).toBe(0);
});

it('wires the policy controller and engine observer to durable storage without saving RPC rejections', async () => {
  const observer = new ThreadSettingsObserverService(
    { addListener: vi.fn(), addLifecycleListener: vi.fn() } as never,
    service,
  );
  const codex = {
    request: vi.fn((method: string) => {
      if (method === 'thread/read')
        return { thread: { cwd: '/cwd', status: { type: 'idle' } } };
      observer.recordThreadSettings('a', {
        ...policy,
        collaborationMode: null,
      } as unknown as v2.ThreadSettings);
      expect(service.read('a').security).toBeUndefined();
      return {};
    }),
  };
  const controller = new ThreadSecurityPolicyController(
    codex as never,
    observer,
    { assertMutable: vi.fn() } as never,
    undefined,
    service,
  );
  await controller.patchSecurityPolicy('a', policy);
  expect(service.read('a').security).toEqual(policy);
  codex.request.mockImplementation((method: string) => {
    if (method === 'thread/read')
      return { thread: { cwd: '/cwd', status: { type: 'idle' } } };
    throw new Error('Rejected');
  });
  await expect(
    controller.patchSecurityPolicy('a', { approvalPolicy: 'never' }),
  ).rejects.toThrow('Rejected');
  expect(service.read('a').security).toEqual(policy);
  observer.forget('a');
  expect(service.read('a').revision).toBe(0);
});

it('confirms and persists automatic approvals only with the bounded native profile, and restores manual mode explicitly', () => {
  const native = { approvalPolicy: boundedApprovalPolicy('on-request') };
  const patch = {
    approvalPolicy: 'on-request',
    approvalMode: 'automatic',
  } as const;
  service
    .beginSecurity('a', patch, '/cwd', observed({}), native, 'own')
    .accept();
  service.observeSecurity('a', {
    ...observed(native),
    activePermissionProfileId: 'foreign',
  });
  expect(service.automaticApprovals('a')).toBe(false);
  service.observeSecurity('a', {
    ...observed(native),
    activePermissionProfileId: 'own',
  });
  const restarted = new ThreadExecutionPreferencesService(storage.db);
  expect(restarted.automaticApprovals('a')).toBe(true);
  expect(restarted.automaticApprovals('b')).toBe(false);
  expect(restarted.forTurn('a')).toEqual(native);
  expect(restarted.forTurn('a')).not.toHaveProperty('approvalMode');
  restarted
    .beginSecurity(
      'a',
      { approvalPolicy: 'never' },
      '/cwd',
      observed({ approvalPolicy: 'never' }),
    )
    .accept();
  expect(restarted.automaticApprovals('a')).toBe(false);
  expect(restarted.forTurn('a')).toEqual({ approvalPolicy: 'never' });
});

it('requires thread access for reads and administrator rights plus mutability for writes', () => {
  const deletion = { assertMutable: vi.fn() };
  const controller = new ThreadExecutionPreferencesController(
    service,
    deletion as unknown as ThreadDeletionRegistryService,
  );
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
      expect(controller.read('a').revision).toBe(0);
      expect(() => controller.set('a', { effort: 'high' })).toThrow(
        'Administrator required',
      );
      identities.requireThread.mockImplementation(() => {
        throw new Error('Forbidden');
      });
      expect(() => controller.read('a')).toThrow('Forbidden');
    },
  );
  deletion.assertMutable.mockImplementation(() => {
    throw new Error('Deleted');
  });
  expect(() => controller.set('a', { effort: 'high' })).toThrow('Deleted');
  expect(service.read('a').revision).toBe(0);
});
