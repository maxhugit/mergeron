import { describe, expect, it, vi } from 'vitest';
import { GitMutationGateService } from './git-mutation-gate.service';
import type { ThreadExecutionInventoryService } from './thread-execution-inventory.service';
import type { CodexProcessManager } from '../codex/codex-process-manager.service';
const manager = { getClient: () => ({}) } as CodexProcessManager;

it('reserves controlled local preparation for the sole active caller without opening UI writes', async () => {
  let active = ['caller'];
  const gate = new GitMutationGateService(
    { snapshot: () => active } as unknown as ThreadExecutionInventoryService,
    manager,
  );
  let finish!: () => void;
  const pending = gate.mutateFromAgent(
    'caller',
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await expect(gate.mutate(() => Promise.resolve())).rejects.toThrow(
    'GIT_BUSY',
  );
  await expect(gate.startTurn(() => Promise.resolve())).rejects.toThrow(
    'GIT_BUSY',
  );
  await expect(
    gate.mutateFromAgent('caller', () => Promise.resolve()),
  ).rejects.toThrow('GIT_BUSY');
  finish();
  await pending;
  active = ['caller', 'child'];
  await expect(
    gate.mutateFromAgent('caller', () => Promise.resolve()),
  ).rejects.toThrow('GIT_BUSY');
  active = [];
  await expect(
    gate.mutateFromAgent('caller', () => Promise.resolve()),
  ).rejects.toThrow('GIT_AGENT_STATE_UNKNOWN');
});

it('fails closed when the agent connection is unavailable', async () => {
  const gate = new GitMutationGateService(
    { snapshot: () => [] } as unknown as ThreadExecutionInventoryService,
    { getClient: () => null } as CodexProcessManager,
  );
  await expect(gate.mutate(() => Promise.resolve())).rejects.toThrow(
    'GIT_AGENT_STATE_UNKNOWN',
  );
});

it('excludes turn starts and concurrent Git writes, and releases after failures', async () => {
  const gate = new GitMutationGateService(
    {
      snapshot: () => [],
    } as unknown as ThreadExecutionInventoryService,
    manager,
  );
  let finish!: () => void;
  const writing = gate.mutate(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await expect(gate.startTurn(() => Promise.resolve())).rejects.toThrow(
    'GIT_BUSY',
  );
  await expect(gate.mutate(() => Promise.resolve())).rejects.toThrow(
    'GIT_BUSY',
  );
  finish();
  await writing;
  await expect(
    gate.mutate(() => Promise.reject(new Error('failed'))),
  ).rejects.toThrow('failed');
  await expect(gate.startTurn(() => Promise.resolve('ok'))).resolves.toBe('ok');
});
it('blocks Git writes while a turn start is awaiting its response', async () => {
  const gate = new GitMutationGateService(
    {
      snapshot: () => [],
    } as unknown as ThreadExecutionInventoryService,
    manager,
  );
  let finish!: () => void;
  const starting = gate.startTurn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await expect(gate.mutate(() => Promise.resolve())).rejects.toThrow(
    'GIT_BUSY',
  );
  finish();
  await starting;
  await expect(gate.mutate(() => Promise.resolve('ok'))).resolves.toBe('ok');
});

it('allows only remote publication by the sole active caller and preserves the UI mutation barrier', async () => {
  let active = ['caller'];
  const gate = new GitMutationGateService(
    { snapshot: () => active } as unknown as ThreadExecutionInventoryService,
    manager,
  );
  await expect(gate.mutate(() => Promise.resolve())).rejects.toThrow(
    'GIT_BUSY',
  );
  await expect(
    gate.publishFromAgent('caller', () => Promise.resolve('published')),
  ).resolves.toBe('published');
  active = ['caller', 'other'];
  await expect(
    gate.publishFromAgent('caller', () => Promise.resolve()),
  ).rejects.toThrow('GIT_BUSY');
  active = [];
  await expect(
    gate.publishFromAgent('caller', () => Promise.resolve()),
  ).rejects.toThrow('GIT_AGENT_STATE_UNKNOWN');
});

it('excludes concurrent publication, UI writes and new turns until publication ends', async () => {
  const gate = new GitMutationGateService(
    {
      snapshot: () => ['caller'],
    } as unknown as ThreadExecutionInventoryService,
    manager,
  );
  let finish!: () => void;
  const pending = gate.publishFromAgent(
    'caller',
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await expect(
    gate.publishFromAgent('caller', () => Promise.resolve()),
  ).rejects.toThrow('GIT_BUSY');
  await expect(gate.mutate(() => Promise.resolve())).rejects.toThrow(
    'GIT_BUSY',
  );
  await expect(gate.startTurn(() => Promise.resolve())).rejects.toThrow(
    'GIT_BUSY',
  );
  finish();
  await pending;
  await expect(
    gate.publishFromAgent('caller', () => Promise.reject(new Error('failed'))),
  ).rejects.toThrow('failed');
  await expect(gate.startTurn(() => Promise.resolve('ok'))).resolves.toBe('ok');
});

describe('concurrent operations on isolated agent copies', () => {
  const container = '/workspaces/p/sources/.external/git';
  const a = `${container}/a`,
    b = `${container}/b`,
    c = `${container}/c`;
  const scopeA = { copyPath: a, remoteRef: 'connection:refs/heads/feature-a' };
  const scopeB = { copyPath: b, remoteRef: 'connection:refs/heads/feature-b' };
  function setup() {
    let generation = 1;
    let active = ['alice', 'bob'];
    let lifecycle!: () => void;
    let notification!: (note: {
      method: string;
      params: { threadId: string };
    }) => void;
    const gate = new GitMutationGateService(
      { snapshot: () => active } as unknown as ThreadExecutionInventoryService,
      {
        getClient: () => ({}),
        getGeneration: () => generation,
        addLifecycleListener: (listener: () => void) => {
          lifecycle = listener;
        },
        addListener: (_event: string, listener: typeof notification) => {
          notification = listener;
        },
      } as unknown as CodexProcessManager,
    );
    const proof = (copyPath: string | null) => ({
      writableCopyPath: copyPath,
      readOnlyRoots: [container],
    });
    gate.recordIsolation('alice', proof(a));
    gate.recordIsolation('bob', proof(b));
    gate.recordIsolation('carol', proof(c));
    return {
      gate,
      proof,
      setActive: (ids: string[]) => {
        active = ids;
      },
      close: (threadId: string) =>
        notification({ method: 'thread/closed', params: { threadId } }),
      replace: () => {
        generation++;
        lifecycle();
      },
    };
  }
  function deferred() {
    let resolve!: () => void;
    const operation = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    return { operation, finish: () => resolve() };
  }
  it('runs preparation on two isolated copies concurrently while keeping UI writes and same-copy writes exclusive', async () => {
    const { gate } = setup();
    const first = deferred(),
      second = deferred();
    const one = gate.mutateFromAgent('alice', first.operation, scopeA);
    const two = gate.mutateFromAgent('bob', second.operation, scopeB);
    expect(first.operation).toHaveBeenCalledOnce();
    expect(second.operation).toHaveBeenCalledOnce();
    await expect(
      gate.mutateFromAgent('alice', () => Promise.resolve(), scopeA),
    ).rejects.toThrow('GIT_BUSY');
    await expect(gate.mutate(() => Promise.resolve())).rejects.toThrow(
      'GIT_BUSY',
    );
    await expect(
      gate.startTurn(() => Promise.resolve(), 'carol'),
    ).resolves.toBeUndefined();
    await expect(
      gate.startTurn(() => Promise.resolve(), 'alice'),
    ).rejects.toThrow('GIT_BUSY');
    await expect(gate.startTurn(() => Promise.resolve())).rejects.toThrow(
      'GIT_BUSY',
    );
    first.finish();
    second.finish();
    await Promise.all([one, two]);
  });
  it('publishes different branches of the same connection concurrently and serializes a shared remote ref', async () => {
    const { gate } = setup();
    const first = deferred(),
      second = deferred();
    const one = gate.publishFromAgent('alice', first.operation, scopeA);
    const refused = vi.fn(() => Promise.resolve());
    await expect(
      gate.publishFromAgent('bob', refused, {
        ...scopeB,
        remoteRef: scopeA.remoteRef,
      }),
    ).rejects.toThrow('GIT_BUSY');
    expect(refused).not.toHaveBeenCalled();
    const two = gate.publishFromAgent('bob', second.operation, scopeB);
    expect(first.operation).toHaveBeenCalledOnce();
    expect(second.operation).toHaveBeenCalledOnce();
    first.finish();
    second.finish();
    await Promise.all([one, two]);
    await expect(
      gate.publishFromAgent('bob', () => Promise.resolve(), {
        ...scopeB,
        remoteRef: scopeA.remoteRef,
      }),
    ).resolves.toBeUndefined();
  });
  it('rejects a forged copy scope, an unprotected session and a second active owner of the same copy', async () => {
    const { gate, proof, setActive } = setup();
    await expect(
      gate.mutateFromAgent('alice', () => Promise.resolve(), scopeB),
    ).rejects.toThrow('GIT_COPY_OWNED');
    setActive(['alice', 'unknown']);
    await expect(
      gate.mutateFromAgent('alice', () => Promise.resolve(), scopeA),
    ).rejects.toThrow('GIT_BUSY');
    gate.recordIsolation('unknown', proof(a));
    await expect(
      gate.mutateFromAgent('alice', () => Promise.resolve(), scopeA),
    ).rejects.toThrow('GIT_BUSY');
    gate.recordIsolation('unknown', {
      writableCopyPath: b,
      readOnlyRoots: ['/workspaces/another'],
    });
    await expect(
      gate.mutateFromAgent('alice', () => Promise.resolve(), scopeA),
    ).rejects.toThrow('GIT_BUSY');
    gate.recordIsolation('unknown', proof(null));
    await expect(
      gate.mutateFromAgent('alice', () => Promise.resolve(), scopeA),
    ).resolves.toBeUndefined();
  });
  it('uses pending turn scopes without excluding unrelated starts and never assumes an unknown pending turn is isolated', async () => {
    const { gate } = setup();
    const pending = deferred();
    const start = gate.startTurn(pending.operation, 'bob');
    await expect(
      gate.mutateFromAgent('alice', () => Promise.resolve(), scopeA),
    ).resolves.toBeUndefined();
    await expect(
      gate.mutateFromAgent('bob', () => Promise.resolve(), scopeB),
    ).rejects.toThrow('GIT_BUSY');
    pending.finish();
    await start;
    const unknown = deferred();
    const unknownStart = gate.startTurn(unknown.operation);
    await expect(
      gate.mutateFromAgent('alice', () => Promise.resolve(), scopeA),
    ).rejects.toThrow('GIT_BUSY');
    unknown.finish();
    await unknownStart;
  });
  it('retires proof when a conversation closes and does not infer safety from a distinct copy alone', async () => {
    const { gate, close } = setup();
    close('bob');
    expect(gate.hasIsolation('bob')).toBe(false);
    await expect(
      gate.mutateFromAgent('alice', () => Promise.resolve(), scopeA),
    ).rejects.toThrow('GIT_BUSY');
  });

  it('releases copy and remote-ref locks after errors, and invalidates proofs after engine replacement', async () => {
    const { gate, replace } = setup();
    await expect(
      gate.publishFromAgent(
        'alice',
        () => Promise.reject(new Error('failed')),
        scopeA,
      ),
    ).rejects.toThrow('failed');
    await expect(
      gate.publishFromAgent('bob', () => Promise.resolve(), {
        ...scopeB,
        remoteRef: scopeA.remoteRef,
      }),
    ).resolves.toBeUndefined();
    replace();
    expect(gate.hasIsolation('alice')).toBe(false);
    await expect(
      gate.mutateFromAgent('alice', () => Promise.resolve(), scopeA),
    ).rejects.toThrow('GIT_BUSY');
  });
});
