import type { v2 } from '../codex/codex-schema';
import { ThreadSecurityPolicyController } from './thread-security-policy.controller';
import { boundedApprovalPolicy } from './agent-approval-policy';

describe('ThreadSecurityPolicyController', () => {
  const codex = { request: vi.fn() };
  const observer = { readSecurityPolicy: vi.fn() };
  const deletion = { assertMutable: vi.fn() };
  const controller = new ThreadSecurityPolicyController(
    codex as never,
    observer as never,
    deletion as never,
  );

  beforeEach(() => {
    vi.resetAllMocks();
    codex.request.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'thread/read'
          ? { thread: { status: { type: 'idle' } } }
          : {},
      ),
    );
  });

  it('queues both policy leaves together without claiming effective values', async () => {
    const patch = {
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    } as const;
    await expect(controller.patchSecurityPolicy('t1', patch)).resolves.toEqual({
      status: 'accepted',
    });
    expect(codex.request).toHaveBeenNthCalledWith(1, 'thread/read', {
      threadId: 't1',
      includeTurns: false,
    });
    expect(codex.request).toHaveBeenNthCalledWith(2, 'thread/settings/update', {
      threadId: 't1',
      ...patch,
    });
    expect(observer.readSecurityPolicy).toHaveBeenCalledWith('t1');
  });

  it.each([
    {},
    { approvalPolcy: 'never' },
    { approvalPolicy: 'never', sandbox: 'read-only' },
    { approvalPolicy: null },
    { approvalPolicy: 'on-failure' },
    { approvalPolicy: 'always' },
    { approvalMode: 'always' },
    { approvalMode: 'automatic' },
    { approvalMode: 'automatic', approvalPolicy: 'never' },
    { sandboxPolicy: { type: 'readOnly', networkAcess: false } },
    { sandboxPolicy: { type: 'dangerFullAccess', networkAccess: true } },
    { approvalPolicy: { granular: { rules: true } } },
    {
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['relative'],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    },
  ])(
    'rejects incomplete or unknown fields before making any RPC: %j',
    async (body) => {
      await expect(
        controller.patchSecurityPolicy('t1', body as never),
      ).rejects.toThrow('Invalid security policy field');
      expect(codex.request).not.toHaveBeenCalled();
    },
  );

  it.each<v2.SandboxPolicy>([
    { type: 'readOnly', networkAccess: false },
    { type: 'externalSandbox', networkAccess: 'restricted' },
    {
      type: 'workspaceWrite',
      writableRoots: ['/workspace'],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: false,
    },
  ])('preserves the complete sandbox variant %j', async (sandboxPolicy) => {
    await controller.patchSecurityPolicy('t1', { sandboxPolicy });
    expect(codex.request).toHaveBeenLastCalledWith('thread/settings/update', {
      threadId: 't1',
      sandboxPolicy,
    });
  });

  it('preserves granular approval flags without coercion', async () => {
    const approvalPolicy = {
      granular: {
        sandbox_approval: true,
        rules: false,
        skill_approval: true,
        request_permissions: false,
        mcp_elicitations: true,
      },
    };
    await controller.patchSecurityPolicy('t1', { approvalPolicy });
    expect(codex.request).toHaveBeenLastCalledWith('thread/settings/update', {
      threadId: 't1',
      approvalPolicy,
    });
    await expect(
      controller.patchSecurityPolicy('t1', {
        approvalPolicy: {
          granular: { ...approvalPolicy.granular, rule: true },
        },
      } as never),
    ).rejects.toThrow('granular.rule');
  });

  it('does not acquire ownership to mutate an unloaded/read-only thread', async () => {
    codex.request.mockResolvedValue({
      thread: { status: { type: 'notLoaded' } },
    });
    await expect(
      controller.patchSecurityPolicy('t1', { approvalPolicy: 'never' }),
    ).rejects.toThrow('Open this conversation for writing');
    expect(codex.request).toHaveBeenCalledTimes(1);
  });

  it('changes approvals while preserving the native copy boundary and blocking full access', async () => {
    observer.readSecurityPolicy.mockReturnValue({
      observed: true,
      activePermissionProfileId: 'own',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
      },
    });
    const guarded = new ThreadSecurityPolicyController(
      codex as never,
      observer as never,
      deletion as never,
      {
        policyForThread: vi.fn().mockResolvedValue({
          copyPermissions: {
            writable: 'own',
            readOnly: 'own-read',
            baseProfile: ':workspace',
          },
        }),
      } as never,
    );
    await expect(
      guarded.patchSecurityPolicy('t1', {
        sandboxPolicy: { type: 'dangerFullAccess' },
      }),
    ).rejects.toThrow('GIT_COPY_ISOLATION_REQUIRED');
    expect(codex.request).not.toHaveBeenCalledWith(
      'thread/settings/update',
      expect.anything(),
    );
    await guarded.patchSecurityPolicy('t1', { approvalPolicy: 'on-request' });
    expect(codex.request).toHaveBeenLastCalledWith('thread/settings/update', {
      threadId: 't1',
      permissions: 'own',
      approvalPolicy: boundedApprovalPolicy('on-request'),
    });
    await expect(
      guarded.patchSecurityPolicy('t1', { approvalPolicy: 'never' }),
    ).resolves.toEqual({ status: 'accepted' });
  });

  it('switches read/write using owned profiles, never a legacy sandbox policy or extra roots', async () => {
    observer.readSecurityPolicy.mockReturnValue({
      observed: true,
      activePermissionProfileId: 'own-read',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    const guarded = new ThreadSecurityPolicyController(
      codex as never,
      observer as never,
      deletion as never,
      {
        policyForThread: vi.fn().mockResolvedValue({
          copyPermissions: {
            writable: 'own',
            readOnly: 'own-read',
            baseProfile: ':workspace',
          },
        }),
      } as never,
    );
    const workspace = {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    } as const;
    await guarded.patchSecurityPolicy('t1', {
      sandboxPolicy: { ...workspace, writableRoots: [] },
    });
    expect(codex.request).toHaveBeenLastCalledWith('thread/settings/update', {
      threadId: 't1',
      permissions: 'own',
    });
    await guarded.patchSecurityPolicy('t1', {
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    expect(codex.request).toHaveBeenLastCalledWith('thread/settings/update', {
      threadId: 't1',
      permissions: 'own-read',
    });
    for (const patch of [
      { ...workspace, writableRoots: ['/foreign'] },
      { ...workspace, networkAccess: true },
    ])
      await expect(
        guarded.patchSecurityPolicy('t1', { sandboxPolicy: patch }),
      ).rejects.toThrow('GIT_COPY_ISOLATION_REQUIRED');
  });

  it('propagates upstream rejection without falling back to global config', async () => {
    codex.request
      .mockResolvedValueOnce({ thread: { status: { type: 'idle' } } })
      .mockRejectedValueOnce(new Error('parent-owned child'));
    await expect(
      controller.patchSecurityPolicy('t1', { approvalPolicy: 'never' }),
    ).rejects.toThrow('parent-owned child');
    expect(codex.request).toHaveBeenCalledTimes(2);
  });

  it('checks deletion again after the asynchronous metadata read', async () => {
    deletion.assertMutable
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('deleting');
      });
    await expect(
      controller.patchSecurityPolicy('t1', { approvalPolicy: 'never' }),
    ).rejects.toThrow('deleting');
    expect(codex.request).toHaveBeenCalledTimes(1);
  });

  it('reads observations without loading the thread', () => {
    observer.readSecurityPolicy.mockReturnValue({
      observed: false,
      source: 'unknown',
      approvalPolicy: null,
      sandboxPolicy: null,
      approvalsReviewer: null,
    });
    expect(controller.readSecurityPolicy('t1')).toMatchObject({
      observed: false,
      approvalPolicy: null,
    });
    expect(codex.request).not.toHaveBeenCalled();
  });
});
