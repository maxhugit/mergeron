/** Automatic reads may resume after reconnect; terminal actions must never be replayed. */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTerminalDiscovery } from '@/hooks/use-terminal-discovery';
import { useTerminalSocketEvents } from '@/hooks/use-terminal-socket';
import { installSessionRecovery } from '@/lib/session-recovery';
import i18n from '@/i18n';
import { showSnackbar } from './snackbar-store';
import { useTerminalStore } from './terminal-store';
import { useTerminalViewStore } from './terminal-view-store';
import { useWorkspaceStore } from './workspace-store';
import type { TerminalAck, TerminalConfig } from '@/types/terminal';

type Request = {
  event: string;
  reply: (error: Error | null, response?: TerminalAck) => void;
};
const wire = vi.hoisted(() => ({
  id: 'first-connection',
  owner: 0,
  connected: true,
  emit: vi.fn(),
  listeners: new Map<string, Set<() => void>>(),
  requests: [] as Request[],
}));
vi.mock('@/socket', () => {
  const sockets = [0, 1].map(() => ({
    get id() {
      return wire.id;
    },
    get connected() {
      return wire.connected;
    },
    sendBuffer: [],
    emit: wire.emit,
    on: (name: string, listener: () => void) => {
      const listeners = wire.listeners.get(name) ?? new Set();
      listeners.add(listener);
      wire.listeners.set(name, listeners);
    },
    off: (name: string, listener: () => void) =>
      wire.listeners.get(name)?.delete(listener),
    timeout: () => ({
      emit: (event: string, payload: unknown, reply: Request['reply']) => {
        wire.emit(event, payload);
        wire.requests.push({ event, reply });
      },
    }),
  }));
  return { getSocket: () => sockets[wire.owner] };
});
vi.mock('@/stores/snackbar-store', () => ({ showSnackbar: vi.fn() }));

const initial = useTerminalStore.getState();
const config: TerminalConfig = {
  maxSessions: 42,
  graceMs: 45000,
  scrollback: 5000,
  defaultCwd: null,
};
const take = (event: string) => {
  const index = wire.requests.findIndex((request) => request.event === event);
  expect(index).toBeGreaterThanOrEqual(0);
  return wire.requests.splice(index, 1)[0];
};
let disposeRecovery: (() => void) | undefined;
beforeEach(() => {
  useTerminalStore.setState(initial, true);
  useTerminalViewStore.setState({
    retained: {},
    target: null,
    contextEpochs: {},
  });
  useWorkspaceStore.setState({ contexts: {}, fileViews: {} });
  wire.id = 'first-connection';
  wire.owner = 0;
  wire.connected = true;
  wire.listeners.clear();
  wire.requests = [];
  wire.emit.mockClear();
  vi.mocked(showSnackbar).mockClear();
});
afterEach(() => {
  disposeRecovery?.();
  disposeRecovery = undefined;
});

it('refreshes list/config on the new connection and silently discards both old responses', async () => {
  wire.connected = false;
  await useTerminalStore.getState().refreshConfig();
  wire.connected = true;
  const view = renderHook(() => {
    useTerminalSocketEvents();
    useTerminalDiscovery('thread:a');
  });
  const oldConfig = take('terminal.config');
  const oldList = take('terminal.list');
  act(() => {
    wire.id = 'second-connection';
    for (const listener of wire.listeners.get('connect') ?? []) listener();
  });
  await act(async () => {
    take('terminal.config').reply(null, { ok: true, config });
    take('terminal.list').reply(null, { ok: true, terminals: [], config });
  });
  await act(async () => {
    oldConfig.reply(null, { ok: true, config: { ...config, maxSessions: 99 } });
    oldList.reply(null, {
      ok: false,
      errorCode: 'terminal.disconnected',
      error: 'Terminal connection changed',
    });
  });
  expect(showSnackbar).not.toHaveBeenCalled();
  expect(useTerminalStore.getState().config).toEqual(config);
  expect(useTerminalStore.getState().contexts['thread:a'].hydrated).toBe(true);
  expect(wire.emit.mock.calls.map(([event]) => event).sort()).toEqual([
    'terminal.config',
    'terminal.config',
    'terminal.list',
    'terminal.list',
  ]);
  view.unmount();
  expect(wire.listeners.get('connect')?.size).toBe(0);
});

it('does not introduce terminal configuration reads for a view that never requested them', () => {
  renderHook(useTerminalSocketEvents);
  for (const listener of wire.listeners.get('connect') ?? []) listener();
  expect(wire.emit).not.toHaveBeenCalled();
});

it('waits for connect instead of queuing reads or showing red errors while offline', async () => {
  wire.connected = false;
  renderHook(() => {
    useTerminalSocketEvents();
    useTerminalDiscovery('thread:a');
  });
  await useTerminalStore.getState().refreshConfig();
  await useTerminalStore.getState().ensureContext('thread:a');
  expect(wire.emit).not.toHaveBeenCalled();
  expect(showSnackbar).not.toHaveBeenCalled();
  expect(useTerminalStore.getState().contexts['thread:a']).toBeUndefined();
  await act(async () => {
    wire.connected = true;
    wire.id = 'reconnected';
    for (const listener of wire.listeners.get('connect') ?? []) listener();
    take('terminal.config').reply(null, { ok: true, config });
    take('terminal.list').reply(null, { ok: true, terminals: [] });
  });
  expect(useTerminalStore.getState().contexts['thread:a'].hydrated).toBe(true);
  expect(showSnackbar).not.toHaveBeenCalled();
});

it.each(['terminal.config', 'terminal.list'] as const)(
  'discards a %s acknowledgement if connection changes before its continuation',
  async (event) => {
    const pending =
      event === 'terminal.config'
        ? useTerminalStore.getState().refreshConfig()
        : useTerminalStore.getState().ensureContext('thread:a');
    take(event).reply(null, { ok: true, config, terminals: [] });
    wire.id = 'next-connection';
    await pending;
    expect(useTerminalStore.getState().configLoaded).toBe(false);
    expect(useTerminalStore.getState().contexts['thread:a']).toBeUndefined();
    expect(showSnackbar).not.toHaveBeenCalled();
  },
);

it.each(['identity', 'verification', 'removed-context'] as const)(
  'does not admit a pending list after %s changed',
  async (change) => {
    const pending = useTerminalStore.getState().ensureContext('thread:a');
    if (change === 'identity') wire.owner = 1;
    if (change === 'verification') disposeRecovery = installSessionRecovery();
    if (change === 'removed-context')
      useWorkspaceStore.getState().forgetConversations(['a']);
    take('terminal.list').reply(null, { ok: true, terminals: [], config });
    await pending;
    expect(useTerminalStore.getState().contexts['thread:a']).toBeUndefined();
    expect(useTerminalStore.getState().configLoaded).toBe(false);
    expect(showSnackbar).not.toHaveBeenCalled();
  },
);

it.each([
  'auth.invalid_token',
  'auth.forbidden',
  'terminal.context_mismatch',
  'terminal.invalid_response',
])(
  'keeps a current connection %s refusal visible, without retrying',
  async (errorCode) => {
    for (const event of ['terminal.config', 'terminal.list']) {
      const pending =
        event === 'terminal.config'
          ? useTerminalStore.getState().refreshConfig()
          : useTerminalStore.getState().listContext('thread:a');
      take(event).reply(null, { ok: false, errorCode, error: 'Read refused' });
      await pending;
      expect(showSnackbar).toHaveBeenLastCalledWith('Read refused', 'error');
    }
    expect(wire.emit).toHaveBeenCalledTimes(2);
  },
);

it('keeps real read timeouts visible and does not retry them in a loop', async () => {
  const pending = useTerminalStore.getState().ensureContext('thread:a');
  take('terminal.list').reply(new Error('timeout'));
  await pending;
  expect(showSnackbar).toHaveBeenCalledWith(
    'Terminal request timed out; its outcome is unknown',
    'error',
  );
  expect(wire.emit).toHaveBeenCalledOnce();
});

it('never retries a shell creation and keeps its interrupted outcome visible', async () => {
  const pending = useTerminalStore
    .getState()
    .createTerminal('thread:a', '/workspace');
  wire.id = 'second-connection';
  take('terminal.open').reply(null, { ok: true });
  await expect(pending).resolves.toBeNull();
  expect(showSnackbar).toHaveBeenCalledWith(
    'Terminal connection changed',
    'error',
  );
  expect(wire.emit).toHaveBeenCalledExactlyOnceWith('terminal.open', {
    contextKey: 'thread:a',
    cwd: '/workspace',
  });
});

it('cancels an explicit New action waiting for discovery when the connection changes', async () => {
  const discovery = useTerminalStore.getState().ensureContext('thread:a');
  const create = useTerminalStore
    .getState()
    .createTerminal('thread:a', '/workspace');
  wire.id = 'second-connection';
  take('terminal.list').reply(null, { ok: true, terminals: [] });
  await discovery;
  await expect(create).resolves.toBeNull();
  expect(wire.emit).toHaveBeenCalledExactlyOnceWith('terminal.list', {
    contextKey: 'thread:a',
  });
  expect(showSnackbar).toHaveBeenCalledWith(
    i18n.t('terminalConnectionIsOffline'),
    'error',
  );
});
