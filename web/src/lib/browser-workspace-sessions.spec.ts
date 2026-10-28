import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  browserWorkspaceSnapshot,
  installBrowserWorkspaceSessions,
  readBrowserWorkspaces,
} from './browser-workspace-sessions';
import { useWorkspaceStore } from '@/stores/workspace-store';
const api = vi.hoisted(() => vi.fn());
vi.mock('./browser-api', () => ({ browserApi: api }));
let stop: (() => void) | undefined;
beforeEach(() => {
  sessionStorage.clear();
  useWorkspaceStore.setState({ contexts: {}, fileViews: {} });
  api.mockReset().mockResolvedValue({ alive: true });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});
it('restores each agent’s browser views, selection and layout after the shell remounts', () => {
  stop = installBrowserWorkspaceSessions('alice');
  const store = useWorkspaceStore.getState();
  store.openBrowser('thread:a');
  store.openBrowser('thread:a');
  store.setBrowserOpened('thread:a', 'browser-1', true);
  store.setBrowserLayout('thread:a', {
    browserDocked: true,
    lastBrowserId: 'browser-1',
  });
  store.select('thread:a', 'conversation');
  store.openBrowser('thread:b');
  stop();
  useWorkspaceStore.setState({ contexts: {} });
  stop = installBrowserWorkspaceSessions('alice');
  expect(useWorkspaceStore.getState().contexts['thread:a']).toMatchObject({
    activeId: 'conversation',
    browserDocked: true,
    lastBrowserId: 'browser-1',
    tabs: [
      { id: 'browser-1', opened: true },
      { id: 'browser-2', opened: false },
    ],
  });
  expect(useWorkspaceStore.getState().contexts['thread:b'].activeId).toBe(
    'browser-1',
  );
  expect(
    api.mock.calls.every(([path]) => String(path).endsWith('/keepalive')),
  ).toBe(true);
});
it('keeps inactive agents alive without opening pages and stops when the authenticated shell leaves', async () => {
  vi.useFakeTimers();
  stop = installBrowserWorkspaceSessions('alice');
  const store = useWorkspaceStore.getState();
  store.openBrowser('thread:a');
  store.setBrowserOpened('thread:a', 'browser-1', true);
  store.openBrowser('thread:b');
  store.setBrowserOpened('thread:b', 'browser-1', true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api).toHaveBeenCalledWith(
    '/a/keepalive',
    { instanceId: 'browser-1' },
    expect.any(AbortSignal),
  );
  expect(api).toHaveBeenCalledWith(
    '/b/keepalive',
    { instanceId: 'browser-1' },
    expect.any(AbortSignal),
  );
  stop();
  stop = undefined;
  api.mockClear();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(api).not.toHaveBeenCalled();
});
it('isolates saved views by owner and does not resurrect explicitly closed or deleted views', () => {
  stop = installBrowserWorkspaceSessions('alice');
  useWorkspaceStore.getState().openBrowser('thread:a');
  stop();
  stop = installBrowserWorkspaceSessions('bob');
  expect(useWorkspaceStore.getState().contexts['thread:a'].tabs).toEqual([]);
  stop();
  stop = installBrowserWorkspaceSessions('alice');
  expect(useWorkspaceStore.getState().contexts['thread:a'].tabs).toHaveLength(
    1,
  );
  useWorkspaceStore.getState().forgetConversations(['a']);
  stop();
  stop = installBrowserWorkspaceSessions('alice');
  expect(useWorkspaceStore.getState().contexts['thread:a']).toBeUndefined();
});
it('validates metadata and never persists page contents, URLs or credentials', () => {
  const saved = readBrowserWorkspaces(
    JSON.stringify({
      'thread:a': {
        tabs: [
          {
            id: 'browser-1',
            kind: 'browser',
            opened: true,
            url: 'https://example.org/private',
            password: 'secret',
            image: 'pixels',
          },
          { id: '../other', kind: 'browser' },
          { id: 'browser-1', kind: 'browser' },
        ],
        activeId: '../other',
        browserDocked: true,
      },
    }),
  );
  expect(saved['thread:a'].tabs).toHaveLength(1);
  expect(saved['thread:a'].activeId).toBe('conversation');
  const serialized = JSON.stringify(browserWorkspaceSnapshot(saved));
  for (const value of ['private', 'secret', 'pixels'])
    expect(serialized).not.toContain(value);
  expect(readBrowserWorkspaces('bad json')).toEqual({});
  expect(readBrowserWorkspaces('x'.repeat(64_001))).toEqual({});
});
it('retires legacy local panels without reviving them as isolated sessions or sending container keepalives', async () => {
  vi.useFakeTimers();
  stop = installBrowserWorkspaceSessions('alice');
  useWorkspaceStore.getState().openBrowser('thread:a', 'local');
  useWorkspaceStore.getState().setBrowserOpened('thread:a', 'browser-1', true);
  const saved = readBrowserWorkspaces(
    JSON.stringify(
      browserWorkspaceSnapshot(useWorkspaceStore.getState().contexts),
    ),
  );
  expect(saved['thread:a']).toBeUndefined();
  expect(
    readBrowserWorkspaces(
      JSON.stringify({
        'thread:old': {
          tabs: [{ id: 'browser-1', kind: 'browser', mode: 'local' }],
          activeId: 'browser-1',
        },
      }),
    ),
  ).toEqual({});
  const mixed = readBrowserWorkspaces(
    JSON.stringify({
      'thread:mixed': {
        tabs: [
          { id: 'browser-1', kind: 'browser', mode: 'local' },
          { id: 'browser-2', kind: 'browser', opened: true },
        ],
        activeId: 'browser-1',
      },
    }),
  );
  expect(mixed['thread:mixed']).toMatchObject({
    activeId: 'conversation',
    tabs: [{ id: 'browser-2', opened: true }],
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api).not.toHaveBeenCalled();
});
