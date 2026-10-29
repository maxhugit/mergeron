import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectAgentDefaultsService } from './project-agent-defaults.service';
import type { ProjectExecutionPolicy } from './project-connection-policy.service';
import type { v2 } from '../codex/codex-schema';

const network = {
  enabled: true,
  managedAllowedDomainsOnly: true,
  allowUpstreamProxy: true,
  allowLocalBinding: false,
  dangerouslyAllowAllUnixSockets: false,
  dangerouslyAllowNonLoopbackProxy: false,
  domains: {
    localhost: 'allow',
    '127.0.0.1': 'allow',
    'registry.npmjs.org': 'allow',
  },
};
describe('global new project-agent defaults', () => {
  const request = vi.fn(),
    getSetting = vi.fn();
  const service = new ProjectAgentDefaultsService(
    { request } as never,
    { getSetting } as never,
  );
  const policy = {
    projectId: 'any-project',
    readOnly: false,
  } as ProjectExecutionPolicy;
  beforeEach(() => {
    request
      .mockReset()
      .mockImplementation((method: string) =>
        Promise.resolve(
          method === 'config/read'
            ? { config: {} }
            : { requirements: { network } },
        ),
      );
    getSetting.mockReset().mockReturnValue({ value: true });
  });
  it('applies to every writable project/new agent, never a fixed thread ID or global Core config write', async () => {
    for (const projectId of ['first', 'second', 'brand-new']) {
      expect(
        await service.forNewAgent(
          { cwd: '/workspaces/' + projectId, approvalPolicy: 'on-request' },
          { ...policy, projectId },
        ),
      ).toEqual({
        sandbox: 'workspace-write',
        config: { sandbox_workspace_write: { network_access: true } },
      });
    }
    expect(request).toHaveBeenCalledTimes(6);
    expect(
      request.mock.calls.every(
        ([method]: [unknown, ...unknown[]]) =>
          typeof method === 'string' &&
          ['configRequirements/read', 'config/read'].includes(method),
      ),
    ).toBe(true);
  });
  it('does nothing for nonproject, readonly or administrator-disabled defaults', async () => {
    expect(await service.forNewAgent({}, null)).toEqual({});
    expect(
      await service.forNewAgent({}, { ...policy, readOnly: true }),
    ).toEqual({});
    getSetting.mockReturnValue({ value: false });
    expect(await service.forNewAgent({}, policy)).toEqual({});
    expect(request).not.toHaveBeenCalled();
  });
  it.each<v2.ThreadStartParams>([
    { sandbox: 'read-only' },
    { sandbox: 'workspace-write' },
    { sandbox: 'danger-full-access' },
    { config: { sandbox_mode: 'read-only' } },
    { config: { sandbox_workspace_write: { network_access: false } } },
    { config: { 'sandbox_workspace_write.network_access': false } },
    { config: { default_permissions: 'custom' } },
    { config: { permissions: { custom: {} } } },
  ])('never overrides explicit permissions %j', async (params) => {
    expect(await service.forNewAgent(params, policy)).toEqual({});
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { requirements: null },
    { requirements: {} },
    {
      requirements: {
        network: { ...network, managedAllowedDomainsOnly: false },
      },
    },
    { requirements: { network, allowedSandboxModes: ['read-only'] } },
    { requirements: { network, allowedPermissionProfiles: { custom: true } } },
  ])(
    'keeps existing defaults when requirements are unavailable/incompatible: %j',
    async (response) => {
      request.mockResolvedValue(response);
      expect(await service.forNewAgent({}, policy)).toEqual({});
    },
  );
  it('fails closed on RPC failure or revocation during requirements read', async () => {
    request.mockRejectedValueOnce(new Error('offline'));
    expect(await service.forNewAgent({}, policy)).toEqual({});
    getSetting
      .mockReturnValueOnce({ value: true })
      .mockReturnValue({ value: false });
    expect(await service.forNewAgent({}, policy)).toEqual({});
  });
  it('preserves filesystem limits and does not replace an explicitly selected named profile', async () => {
    const config: Record<string, unknown> = {
      sandbox_workspace_write: {
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
        writable_roots: ['/project'],
      },
    };
    request.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'config/read' ? { config } : { requirements: { network } },
      ),
    );
    expect(await service.forNewAgent({}, policy)).toEqual({
      sandbox: 'workspace-write',
      config: {
        sandbox_workspace_write: {
          ...(config.sandbox_workspace_write as object),
          network_access: true,
        },
      },
    });
    config.default_permissions = 'restricted-profile';
    expect(await service.forNewAgent({}, policy)).toEqual({});
    delete config.default_permissions;
    config.sandbox_mode = 'read-only';
    expect(await service.forNewAgent({}, policy)).toEqual({});
  });
});
