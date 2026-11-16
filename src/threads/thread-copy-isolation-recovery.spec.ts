/** Real lifecycle collaborators; Core retains loaded profiles until its generation changes. */
import { vi, describe, it, expect } from 'vitest';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import { ThreadHistoryService } from './thread-history.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { ThreadSettingsObserverService } from './thread-settings-observer.service';
import { ProjectConnectionRuntimeService } from './project-connection-runtime.service';
import { ThreadsService } from './threads.service';
import type { ProjectExecutionPolicy } from './project-connection-policy.service';

function fixture(readOnly = false) {
  let generation = 1,
    loaded = true,
    active = false,
    wrongAck = false;
  let nativeProfile = 'old-profile',
    nativeCwd = '/old';
  const listeners: Array<
    (event: { type: string; generation: number }) => void
  > = [];
  const policy = (cwd: string, id: string): ProjectExecutionPolicy => ({
    projectId: 'p',
    workspaceId: cwd,
    executionCwd: cwd,
    readOnly: false,
    model: null,
    reasoningEffort: null,
    sourceResourceId: null,
    sourceRevision: null,
    config: {
      default_permissions: id,
      permissions: {
        [id]: { extends: ':workspace' },
        [`${id}-read`]: { extends: ':read-only' },
      },
    },
    copyPermissions: {
      writable: id,
      readOnly: `${id}-read`,
      baseProfile: ':workspace',
      writableCopyPath: '/copy',
      readOnlyRoots: ['/other-copy'],
    },
  });
  const old = policy('/old', 'old-profile'),
    next = policy('/copy', 'new-profile');
  const policies = {
    policyForThread: vi.fn((_thread: string, cwd: string) =>
      Promise.resolve(cwd === '/copy' ? next : old),
    ),
    assertExecutionLocation: vi.fn(),
  };
  const response = () => ({
    thread: {
      id: 'agent',
      cwd: nativeCwd,
      historyMode: 'paginated',
      turns: [],
      status: { type: 'idle' },
    },
    cwd: nativeCwd,
    model: 'fixture',
    modelProvider: 'fixture',
    serviceTier: null,
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: {
      type: readOnly ? 'readOnly' : 'workspaceWrite',
      networkAccess: false,
      writableRoots: [],
    },
    activePermissionProfile: {
      id: wrongAck ? 'old-profile' : nativeProfile,
      extends: readOnly ? ':read-only' : ':workspace',
    },
    reasoningEffort: null,
    initialTurnsPage: { data: [], nextCursor: null, backwardsCursor: null },
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
  });
  const codex = {
    request: vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read')
        return Promise.resolve({
          thread: {
            ...response().thread,
            status: { type: loaded ? 'idle' : 'notLoaded' },
          },
        });
      if (method === 'thread/turns/list')
        return Promise.resolve({
          data: [
            { id: 'past-turn', items: [], status: 'completed', error: null },
          ],
          nextCursor: null,
          backwardsCursor: null,
        });
      if (method === 'thread/resume') {
        if (!loaded) {
          expect(params.config).toEqual(next.config);
          nativeProfile = String(params.permissions);
          nativeCwd = String(params.cwd);
          loaded = true;
        }
        return Promise.resolve(response());
      }
      throw Error(`Unexpected RPC ${method}`);
    }),
  };
  const manager = {
    getGeneration: () => generation,
    addListener: vi.fn(),
    addLifecycleListener: (
      listener: (event: { type: string; generation: number }) => void,
    ) => listeners.push(listener),
    restartControlled: vi.fn((ready?: () => void) => {
      if (active) return Promise.reject(Error('another agent is active'));
      generation++;
      loaded = false;
      ready?.();
      for (const listener of listeners)
        listener({ type: 'appServerReady', generation });
      return Promise.resolve();
    }),
  };
  const runtime = new ProjectConnectionRuntimeService(
    codex as never,
    manager as never,
    policies as never,
    new CatalogAdmissionService(),
    { resolveAgent: () => '/old' } as never,
  );
  const preferences = {
    read: () => ({
      security: {
        sandboxPolicy: { type: readOnly ? 'readOnly' : 'workspaceWrite' },
        approvalPolicy: 'on-request',
      },
    }),
    forTurn: () => ({
      sandboxPolicy: { type: readOnly ? 'readOnly' : 'workspaceWrite' },
      approvalPolicy: 'on-request',
    }),
  };
  const history = new ThreadHistoryService(
    codex as never,
    runtime,
    preferences as never,
  );
  const observer = new ThreadSettingsObserverService(manager as never);
  const registry = new ThreadResumeRegistryService(
    history,
    manager as never,
    observer,
  );
  registry.cacheResponse('agent', response() as never);
  registry.markResumed('agent');
  runtime.record('agent', old);
  const persisted = vi.fn();
  const service = Object.create(ThreadsService.prototype) as ThreadsService;
  Object.assign(service, {
    connections: runtime,
    projectConnections: policies,
    resumeRegistry: registry,
    codex,
    settingsObserver: observer,
    preferences,
    branches: { listKnownTreeThreadIds: () => ['agent'] },
    deletionRegistry: { assertMutable: vi.fn() },
    workspaceOverrides: { setMany: persisted },
  });
  return {
    service,
    runtime,
    manager,
    registry,
    codex,
    persisted,
    next,
    setActive: (value: boolean) => {
      active = value;
    },
    setWrongAck: (value: boolean) => {
      wrongAck = value;
    },
  };
}

describe('copy isolation on workspace reopen', () => {
  it.each([false, true])(
    'refreshes stale profiles before committing the new folder (read-only=%s)',
    async (readOnly) => {
      const f = fixture(readOnly);
      await f.service.setThreadCwd('agent', '/copy');
      expect(f.manager.restartControlled).toHaveBeenCalledOnce();
      expect(f.codex.request).toHaveBeenCalledWith(
        'thread/resume',
        expect.objectContaining({
          cwd: '/copy',
          config: f.next.config,
          permissions: readOnly ? 'new-profile-read' : 'new-profile',
        }),
      );
      expect(f.registry.readCachedPermissionProfile('agent')).toMatchObject({
        activePermissionProfile: {
          id: readOnly ? 'new-profile-read' : 'new-profile',
        },
      });
      expect(f.persisted).toHaveBeenCalledWith(['agent'], '/copy');
      expect(
        f.codex.request.mock.calls.some(([method]) => method === 'turn/start'),
      ).toBe(false);
    },
  );
  it('reopens an assigned folder despite a stale workspace override while another agent is active', async () => {
    const f = fixture();
    f.setActive(true);
    Object.assign(f.service, {
      activeFolders: { resolveAgent: () => '/old' },
      workspaceOverrides: { get: () => '/copy', setMany: f.persisted },
    });

    const opened = await f.service.resumeThread('agent', {
      recordActive: false,
    });

    expect(opened.mode).toBe('writable');
    expect(opened.cwd).toBe('/old');
    expect(f.manager.restartControlled).not.toHaveBeenCalled();
    expect(f.persisted).not.toHaveBeenCalled();
    expect(
      f.codex.request.mock.calls.some(([method]) => method === 'turn/start'),
    ).toBe(false);
  });
  it('preserves folder references if active work prevents a safe refresh, then permits retry', async () => {
    const f = fixture();
    f.setActive(true);
    await expect(f.service.setThreadCwd('agent', '/copy')).rejects.toThrow(
      'arrêtez les agents actifs',
    );
    expect(f.persisted).not.toHaveBeenCalled();
    expect(
      f.codex.request.mock.calls.some(([method]) => method === 'thread/resume'),
    ).toBe(false);
    f.setActive(false);
    await expect(f.service.setThreadCwd('agent', '/copy')).resolves.toEqual([
      'agent',
    ]);
  });
  it('does not refresh the process when native writer ownership has already been refused', async () => {
    const f = fixture();
    vi.spyOn(f.registry, 'ensureOpened').mockResolvedValue({
      mode: 'readOnly',
    } as never);
    await expect(f.service.setThreadCwd('agent', '/copy')).rejects.toThrow(
      'owned by another client',
    );
    expect(f.manager.restartControlled).not.toHaveBeenCalled();
    expect(f.persisted).not.toHaveBeenCalled();
  });
  it('still blocks an engine which does not acknowledge the expected isolation', async () => {
    const f = fixture();
    f.setWrongAck(true);
    await expect(f.service.setThreadCwd('agent', '/copy')).rejects.toThrow(
      'GIT_COPY_ISOLATION_UNAVAILABLE',
    );
    expect(f.persisted).not.toHaveBeenCalled();
    expect(
      f.codex.request.mock.calls.some(([method]) => method === 'turn/start'),
    ).toBe(false);
  });
  it('excludes competing folder changes and model turns while the pending context is being validated', async () => {
    const f = fixture();
    let release!: () => void;
    const pending = f.runtime.prepareLocation(
      'agent',
      '/copy',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(f.runtime.beforeTurn('agent', '/old')).rejects.toThrow(
      'en cours de validation',
    );
    await expect(
      f.runtime.prepareLocation('agent', '/other', () => Promise.resolve()),
    ).rejects.toThrow('en cours de validation');
    release();
    await pending;
    await expect(f.runtime.beforeTurn('agent', '/copy')).resolves.toMatchObject(
      { policy: f.next },
    );
  });
});
