import { ProjectConnectionRuntimeService } from './project-connection-runtime.service';
import {
  ProjectConnectionPolicyService,
  type ProjectExecutionPolicy,
} from './project-connection-policy.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { CodexService } from '../codex/codex.service';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import { CodexRpcError } from '../codex/codex-errors';

describe('project MCP connection lifetime', () => {
  const policy: ProjectExecutionPolicy = {
    projectId: 'p',
    workspaceId: 'w',
    config: {
      features: { apps: false },
      apps: { _default: { enabled: false } },
      mcp_servers: {},
    },
    model: null,
    reasoningEffort: null,
    readOnly: false,
    sourceResourceId: null,
    sourceRevision: null,
  };
  function setup() {
    let generation = 1;
    const manager = {
      addLifecycleListener: vi.fn(),
      addListener: vi.fn(),
      getGeneration: () => generation,
      restartControlled: vi.fn(async (beforeReady?: () => void) => {
        await Promise.resolve();
        beforeReady?.();
        generation++;
        const listener = manager.addLifecycleListener.mock.calls[0][0] as (
          event: unknown,
        ) => void;
        listener({ type: 'appServerReady' });
      }),
    };
    const policies = {
      policyForThread: vi.fn().mockResolvedValue(policy),
      assertExecutionLocation: vi.fn(),
    };
    const codex = {
      request: vi.fn().mockResolvedValue({
        thread: { cwd: '/workspaces/p', status: { type: 'notLoaded' } },
      }),
    };
    const admission = new CatalogAdmissionService();
    const service = new ProjectConnectionRuntimeService(
      codex as unknown as CodexService,
      manager as unknown as CodexProcessManager,
      policies as unknown as ProjectConnectionPolicyService,
      admission,
    );
    return { service, manager, policies, codex, admission };
  }
  it('reuses only sessions whose applied connection policy is unchanged', async () => {
    const { service, manager, policies } = setup();
    service.record('t', policy);
    expect((await service.beforeTurn('t', '/workspaces/p')).restarted).toBe(
      false,
    );
    policies.policyForThread.mockResolvedValue({
      ...policy,
      config: {
        ...policy.config,
        mcp_servers: { fixture: { enabled: false } },
      },
    });
    expect((await service.beforeTurn('t', '/workspaces/p')).restarted).toBe(
      true,
    );
    expect(manager.restartControlled).toHaveBeenCalledOnce();
  });
  it('does not dispatch with an unknown inherited policy on an existing conversation', async () => {
    const { service, manager } = setup();
    expect((await service.beforeTurn('old', '/workspaces/p')).restarted).toBe(
      true,
    );
    expect(manager.restartControlled).toHaveBeenCalledOnce();
  });

  it('preserves a first-turn session when only its location changes, with exact native transports unchanged', async () => {
    const { service, manager, policies, codex } = setup();
    service.record('t', policy);
    const next = {
      ...policy,
      workspaceId: 'git-copy',
      executionCwd: '/copy',
      readOnly: true,
      sourceRevision: 'abc',
    };
    policies.policyForThread.mockResolvedValue(next);
    codex.request.mockRejectedValue(
      new CodexRpcError(
        {
          code: -32600,
          message:
            'thread t is not materialized yet; thread/turns/list is unavailable before first user message',
        },
        { method: 'thread/turns/list' },
      ),
    );
    expect((await service.beforeTurn('t', '/copy')).restarted).toBe(false);
    expect(manager.restartControlled).not.toHaveBeenCalled();
    expect(policies.assertExecutionLocation).toHaveBeenCalledWith(
      next,
      '/copy',
    );
    expect((await service.beforeTurn('t', '/copy')).restarted).toBe(false);
    expect(codex.request).toHaveBeenCalledTimes(1);
  });

  it('does not label missing, unauthorized or uncertain histories as fresh', async () => {
    const { service, manager, policies, codex } = setup();
    service.record('t', policy);
    policies.policyForThread.mockResolvedValue({
      ...policy,
      executionCwd: '/copy',
    });
    codex.request.mockRejectedValue(
      new Error('no rollout found for thread id t'),
    );
    await expect(service.beforeTurn('t', '/copy')).rejects.toThrow(
      'no rollout',
    );
    expect(manager.restartControlled).not.toHaveBeenCalled();
  });

  function freshFixture(name: string | null = null) {
    const fixture = setup();
    const { service, policies, codex, manager } = fixture;
    const next = {
      ...policy,
      config: { ...policy.config, default_permissions: 'new-copy-profile' },
    };
    service.record('t', policy);
    policies.policyForThread.mockResolvedValue(next);
    let persisted = Boolean(name);
    const notifyClosed = () => {
      const listener = manager.addListener.mock.calls[0][1] as (
        note: unknown,
      ) => void;
      listener({ method: 'thread/closed', params: { threadId: 't' } });
    };
    codex.request.mockImplementation((method: string): Promise<unknown> => {
      return Promise.resolve().then(() => {
        if (method === 'thread/turns/list') {
          if (persisted) return { data: [], nextCursor: null };
          throw new CodexRpcError(
            {
              code: -32600,
              message:
                'thread t is not materialized yet; thread/turns/list is unavailable before first user message',
            },
            { method },
          );
        }
        if (method === 'thread/read')
          return {
            thread: {
              id: 't',
              name,
              historyMode: 'paginated',
              ephemeral: false,
              status: { type: 'idle' },
            },
          };
        if (method === 'thread/name/set') {
          persisted = true;
          return {};
        }
        if (method === 'thread/unsubscribe') {
          notifyClosed();
          return { status: 'unsubscribed' };
        }
        throw new Error(`Unexpected native method: ${method}`);
      });
    });
    return { ...fixture, next, notifyClosed };
  }

  it('persists and unloads the same empty agent after Git ownership changes, without restarting other agents', async () => {
    const { service, manager, codex, next } = freshFixture();
    expect(await service.beforeTurn('t', '/workspaces/p')).toMatchObject({
      policy: next,
      restarted: false,
      reopened: true,
      generation: 1,
    });
    expect(
      codex.request.mock.calls.map(([method]) => method as string),
    ).toEqual([
      'thread/turns/list',
      'thread/read',
      'thread/name/set',
      'thread/turns/list',
      'thread/unsubscribe',
    ]);
    expect(codex.request).toHaveBeenCalledWith('thread/name/set', {
      threadId: 't',
      name: 't',
    });
    expect(service.isPlaceholderName('t', 't')).toBe(true);
    expect(service.isPlaceholderName('t', 'My title')).toBe(false);
    expect(manager.restartControlled).not.toHaveBeenCalled();
    // Only the normal, acknowledged native resume may record the new policy.
    service.record('t', next);
    expect((await service.beforeTurn('t', '/workspaces/p')).restarted).toBe(
      false,
    );
    expect(codex.request).toHaveBeenCalledTimes(5);
  });

  it('also refreshes an already named, persisted empty agent without a global restart', async () => {
    const { service, codex, manager } = freshFixture(
      'Named before first input',
    );
    const native = codex.request.getMockImplementation()! as (
      method: string,
    ) => Promise<unknown>;
    codex.request.mockImplementation((method: string) =>
      method === 'thread/turns/list'
        ? Promise.resolve({ data: [], nextCursor: null })
        : native(method),
    );
    expect(await service.beforeTurn('t', '/workspaces/p')).toMatchObject({
      reopened: true,
      restarted: false,
    });
    expect(manager.restartControlled).not.toHaveBeenCalled();
  });

  it('retains observed model and read-only settings until the new native profile is recorded', async () => {
    const { service, next } = freshFixture();
    Object.assign(service, {
      settingsObserver: {
        readSettings: () => ({
          settings: {
            model: 'chosen-model',
            modelProvider: 'local',
            effort: 'high',
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            serviceTier: null,
            sandboxPolicy: { type: 'readOnly' },
          },
        }),
      },
    });
    await service.beforeTurn('t', '/workspaces/p');
    expect(service.freshResumeState('t')).toMatchObject({
      generation: 1,
      parameters: {
        model: 'chosen-model',
        modelProvider: 'local',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        serviceTier: null,
      },
      effort: 'high',
      readOnly: true,
    });
    service.record('t', next);
    expect(service.freshResumeState('t')).toBeUndefined();
  });

  it('times out without claiming that the native thread was released', async () => {
    vi.useFakeTimers();
    try {
      const { service, codex } = freshFixture();
      const native = codex.request.getMockImplementation()! as (
        method: string,
      ) => Promise<unknown>;
      codex.request.mockImplementation((method: string) =>
        method === 'thread/unsubscribe'
          ? Promise.resolve({ status: 'unsubscribed' })
          : native(method),
      );
      const refresh = service.beforeTurn('t', '/workspaces/p');
      const rejected = expect(refresh).rejects.toThrow('fermeture');
      await vi.advanceTimersByTimeAsync(5001);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an existing title when persisting a new conversation', async () => {
    const { service, codex } = freshFixture('My agent');
    await service.beforeTurn('t', '/workspaces/p');
    expect(codex.request).not.toHaveBeenCalledWith(
      'thread/name/set',
      expect.anything(),
    );
    expect(service.isPlaceholderName('t', 't')).toBe(false);
  });

  it('deduplicates simultaneous first-turn permission refreshes', async () => {
    const { service, codex } = freshFixture();
    await Promise.all([
      service.beforeTurn('t', '/workspaces/p'),
      service.beforeTurn('t', '/workspaces/p'),
    ]);
    expect(
      codex.request.mock.calls.filter(
        ([method]) => method === 'thread/name/set',
      ),
    ).toHaveLength(1);
    expect(
      codex.request.mock.calls.filter(
        ([method]) => method === 'thread/unsubscribe',
      ),
    ).toHaveLength(1);
  });

  it.each(['active', 'notLoaded'])(
    'does not unload an agent whose native state is %s',
    async (status) => {
      const { service, codex, manager } = freshFixture();
      const native = codex.request.getMockImplementation()! as (
        method: string,
      ) => Promise<unknown>;
      codex.request.mockImplementation((method: string) =>
        method === 'thread/read'
          ? Promise.resolve({
              thread: {
                id: 't',
                historyMode: 'paginated',
                status: { type: status },
              },
            })
          : native(method),
      );
      await expect(service.beforeTurn('t', '/workspaces/p')).rejects.toThrow(
        'inactif',
      );
      expect(codex.request).not.toHaveBeenCalledWith(
        'thread/unsubscribe',
        expect.anything(),
      );
      expect(manager.restartControlled).not.toHaveBeenCalled();
    },
  );

  it('does not unload before persistence is confirmed by an empty native history', async () => {
    const { service, codex, manager } = freshFixture();
    const native = codex.request.getMockImplementation()! as (
      method: string,
    ) => Promise<unknown>;
    let pageCalls = 0;
    codex.request.mockImplementation((method: string) =>
      method === 'thread/turns/list' && ++pageCalls > 1
        ? Promise.resolve({
            data: [{ id: 'started-elsewhere' }],
            nextCursor: null,
          })
        : native(method),
    );
    await expect(service.beforeTurn('t', '/workspaces/p')).rejects.toThrow(
      'démarré',
    );
    expect(codex.request).not.toHaveBeenCalledWith(
      'thread/unsubscribe',
      expect.anything(),
    );
    expect(manager.restartControlled).not.toHaveBeenCalled();
  });

  it('preserves the native session when persisting its metadata fails', async () => {
    const { service, codex, manager } = freshFixture();
    const native = codex.request.getMockImplementation()! as (
      method: string,
    ) => Promise<unknown>;
    codex.request.mockImplementation((method: string) =>
      method === 'thread/name/set'
        ? Promise.reject(new Error('disk unavailable'))
        : native(method),
    );
    await expect(service.beforeTurn('t', '/workspaces/p')).rejects.toThrow(
      'disk unavailable',
    );
    expect(codex.request).not.toHaveBeenCalledWith(
      'thread/unsubscribe',
      expect.anything(),
    );
    expect(manager.restartControlled).not.toHaveBeenCalled();
  });

  it('waits for thread/closed, not just the unsubscribe response', async () => {
    const { service, codex, notifyClosed } = freshFixture();
    const native = codex.request.getMockImplementation()! as (
      method: string,
    ) => Promise<unknown>;
    codex.request.mockImplementation((method: string) =>
      method === 'thread/unsubscribe'
        ? Promise.resolve({ status: 'unsubscribed' })
        : native(method),
    );
    let resolved = false;
    const refresh = service.beforeTurn('t', '/workspaces/p').then(() => {
      resolved = true;
    });
    await vi.waitFor(() =>
      expect(codex.request).toHaveBeenCalledWith('thread/unsubscribe', {
        threadId: 't',
      }),
    );
    expect(resolved).toBe(false);
    notifyClosed();
    await refresh;
    expect(resolved).toBe(true);
  });

  it('fails closed when native release is refused', async () => {
    const { service, codex } = freshFixture();
    const native = codex.request.getMockImplementation()! as (
      method: string,
    ) => Promise<unknown>;
    codex.request.mockImplementation((method: string) =>
      method === 'thread/unsubscribe'
        ? Promise.resolve({ status: 'notSubscribed' })
        : native(method),
    );
    await expect(service.beforeTurn('t', '/workspaces/p')).rejects.toThrow(
      'libération',
    );
  });

  it('does not renew an unknown or cross-project fresh session', async () => {
    const { service, policies, codex } = freshFixture();
    policies.policyForThread.mockResolvedValue({
      ...policy,
      projectId: 'another-project',
    });
    await expect(service.beforeTurn('t', '/workspaces/p')).rejects.toThrow(
      'inconnu',
    );
    expect(codex.request).not.toHaveBeenCalledWith(
      'thread/name/set',
      expect.anything(),
    );
    await expect(
      service.beforeTurn('unknown', '/workspaces/p'),
    ).rejects.toThrow('inconnu');
  });

  it.each([
    { readOnly: true },
    { locationId: 'local:new-location' },
    { sourceRevision: 'new-revision' },
    { executionCwd: '/workspaces/p/nested' },
  ])(
    'does not reuse the previous native session after location settings change: %j',
    async (change) => {
      const { service, manager, policies } = setup();
      service.record('t', policy);
      policies.policyForThread.mockResolvedValue({ ...policy, ...change });
      expect((await service.beforeTurn('t', '/workspaces/p')).restarted).toBe(
        true,
      );
      expect(manager.restartControlled).toHaveBeenCalledOnce();
    },
  );

  it('does not restart just because native config keys are returned in a different order', async () => {
    const { service, manager, policies } = setup();
    service.record('t', policy);
    policies.policyForThread.mockResolvedValue({
      ...policy,
      config: {
        mcp_servers: {},
        apps: { _default: { enabled: false } },
        features: { apps: false },
      },
    });
    expect((await service.beforeTurn('t', '/workspaces/p')).restarted).toBe(
      false,
    );
    expect(manager.restartControlled).not.toHaveBeenCalled();
  });
  it('refuses policy replacement if Core cannot establish idle', async () => {
    const { service, manager } = setup();
    manager.restartControlled.mockRejectedValue(new Error('active work'));
    await expect(service.beforeTurn('t', '/workspaces/p')).rejects.toThrow(
      'agents actifs',
    );
  });
  it('commits selection only after old connections are gone, before automatic resumes', async () => {
    const { service, admission } = setup();
    const write = vi.fn(() => {
      expect(() => admission.enter('turn')).toThrow();
      return 'saved';
    });
    await expect(service.change(write)).resolves.toBe('saved');
    expect(write).toHaveBeenCalledOnce();
    expect(() => admission.enter('later')).not.toThrow();
  });
  it('preserves the previous selection when active work or a competing mutation blocks restart', async () => {
    const { service, manager, admission } = setup();
    const write = vi.fn();
    manager.restartControlled.mockRejectedValue(new Error('active'));
    await expect(service.change(write)).rejects.toThrow('sélection précédente');
    expect(write).not.toHaveBeenCalled();
    const release = admission.enter('another request');
    await expect(service.change(write)).rejects.toThrow('Mutations');
    release();
    expect(write).not.toHaveBeenCalled();
  });
  it('does not mark a stale response as applied in a later process generation', async () => {
    const { service, manager } = setup();
    const generation = service.generation();
    await manager.restartControlled();
    service.record('t', policy, generation);
    expect((await service.beforeTurn('t', '/workspaces/p')).restarted).toBe(
      true,
    );
  });
  it('requires replacement rather than trusting resume overrides on a loaded session', async () => {
    const { service, codex, manager } = setup();
    codex.request.mockResolvedValue({
      thread: { cwd: '/workspaces/p', status: { type: 'idle' } },
    });
    await expect(service.forResume('t')).rejects.toThrow('Rouvrez');
    expect(manager.restartControlled).toHaveBeenCalledOnce();
  });
});
