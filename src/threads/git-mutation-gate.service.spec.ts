import { expect, it } from 'vitest';
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
