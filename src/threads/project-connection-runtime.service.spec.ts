import { ProjectConnectionRuntimeService } from './project-connection-runtime.service';
import {
  ProjectConnectionPolicyService,
  type ProjectExecutionPolicy,
} from './project-connection-policy.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { CodexService } from '../codex/codex.service';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';

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
    const policies = { policyForThread: vi.fn().mockResolvedValue(policy) };
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
