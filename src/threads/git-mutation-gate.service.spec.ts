import { expect, it } from 'vitest';
import { GitMutationGateService } from './git-mutation-gate.service';
import type { ThreadExecutionInventoryService } from './thread-execution-inventory.service';
import type { CodexProcessManager } from '../codex/codex-process-manager.service';
const manager = { getClient: () => ({}) } as CodexProcessManager;

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
