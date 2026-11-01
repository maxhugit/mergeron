import { useTimelineStore } from '@/stores/timeline-store';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { McpStatusBadge } from './mcp-status-badge';
import { useMcpStore } from '@/stores/mcp-store';

const mock = vi.hoisted(() => ({ list: vi.fn(), reload: vi.fn() }));
vi.mock('@/generated/api/sdk.gen', () => ({
  mcpServersListServers: mock.list,
  mcpServersReloadAll: mock.reload,
}));
vi.mock('@/hooks/use-current-project', () => ({
  useCurrentProject: () => ({ id: 'project', mcpServerIds: ['external'] }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { ready?: number; total?: number }) =>
      values?.total !== undefined ? `${values.ready}/${values.total}` : key,
  }),
}));
const pristineTimeline = useTimelineStore.getState();
let client: QueryClient;
beforeEach(() => {
  useTimelineStore.setState(pristineTimeline, true);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mock.list.mockReset();
  useTimelineStore.getState().ensureThreadState({ threadId: 'agent-a' });
  useTimelineStore
    .getState()
    .setOpenStateForThread('agent-a', { openState: 'ready' });
  useTimelineStore.getState().ensureThreadState({ threadId: 'agent-b' });
  useTimelineStore
    .getState()
    .setOpenStateForThread('agent-b', { openState: 'ready' });
  useMcpStore.setState({ statuses: {} });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function show(threadId = 'agent-a') {
  return render(
    <QueryClientProvider client={client}>
      <McpStatusBadge threadId={threadId} menuItem />
    </QueryClientProvider>,
  );
}
const internal = {
  name: 'mergeron_internal',
  tools: { project_read: {} },
  authStatus: 'unsupported',
};
it('reads the actual agent inventory, includes internal Mergeron and ignores unrelated startup notifications', async () => {
  useMcpStore.setState({
    statuses: {
      mergeron_internal: {
        name: 'mergeron_internal',
        status: 'failed',
        error: 'another session',
        updatedAt: Date.now(),
      },
    },
  });
  mock.list.mockResolvedValue({
    data: { data: [internal, { name: 'outside-project', tools: {} }] },
  });
  show();
  fireEvent.click(
    await screen.findByRole('button', { name: 'mcpServers · 1/1' }),
  );
  expect(screen.getByText('mcpInternalMergeron')).toBeInTheDocument();
  expect(screen.getByText('ready')).toBeInTheDocument();
  expect(screen.queryByText('outside-project')).toBeNull();
  expect(screen.queryByText('another session')).toBeNull();
  expect(mock.list).toHaveBeenCalledWith(
    expect.objectContaining({
      query: { detail: 'toolsAndAuthOnly', threadId: 'agent-a' },
    }),
  );
  expect(screen.getByRole('button', { name: 'reloadAll' })).toBeDisabled();
});
it('does not reuse agent A inventory for agent B or pretend an unobserved internal connection is ready', async () => {
  mock.list.mockImplementation(({ query }) =>
    Promise.resolve({
      data: { data: query.threadId === 'agent-a' ? [internal] : [] },
    }),
  );
  const view = show();
  await screen.findByRole('button', { name: 'mcpServers · 1/1' });
  view.rerender(
    <QueryClientProvider client={client}>
      <McpStatusBadge threadId="agent-b" menuItem />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(mock.list).toHaveBeenCalledTimes(2));
  fireEvent.click(
    await screen.findByRole('button', { name: 'mcpServers · 0/1' }),
  );
  expect(screen.getByText('mcpNotObserved')).toBeInTheDocument();
  expect(screen.queryByText('ready')).toBeNull();
});
it('shows an inventory error rather than claiming an MCP outage or a successful connection', async () => {
  mock.list.mockRejectedValue(new Error('unreachable'));
  show();
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'mcpServers · failedToLoadMcpServers',
    }),
  );
  expect(
    screen.getByText('failedToLoadMcpServers', { selector: 'p' }),
  ).toBeInTheDocument();
  expect(screen.getByText('mcpNotObserved')).toBeInTheDocument();
  expect(screen.queryByText('ready')).toBeNull();
});

it('does not inspect connections of a read-only fallback after a failed resume', async () => {
  const store = useTimelineStore.getState();
  store.ensureThreadState({ threadId: 'failed-open', mode: 'readOnly' });
  store.setOpenStateForThread('failed-open', { openState: 'ready' });
  show('failed-open');
  await screen.findByRole('button', { name: 'mcpServers · 0/1' });
  expect(mock.list).not.toHaveBeenCalled();
});
it('waits for writer acquisition before inspecting thread connections', async () => {
  const store = useTimelineStore.getState();
  store.ensureThreadState({ threadId: 'opening' });
  show('opening');
  expect(mock.list).not.toHaveBeenCalled();
  mock.list.mockResolvedValue({ data: { data: [internal] } });
  store.setOpenStateForThread('opening', { openState: 'ready' });
  await screen.findByRole('button', { name: 'mcpServers · 1/1' });
  expect(mock.list).toHaveBeenCalledTimes(1);
});
it('stops automatic retries and polling after an inventory failure', async () => {
  mock.list.mockRejectedValue(new Error('thread not found: agent-a'));
  show();
  await screen.findByRole('button', {
    name: 'mcpServers · failedToLoadMcpServers',
  });
  await new Promise((resolve) => setTimeout(resolve, 5200));
  expect(mock.list).toHaveBeenCalledTimes(1);
}, 10000);

it('does not present a cached live connection as ready after the thread becomes read-only', async () => {
  mock.list.mockResolvedValue({ data: { data: [internal] } });
  show();
  await screen.findByRole('button', { name: 'mcpServers · 1/1' });
  useTimelineStore
    .getState()
    .setReadOnlyThread({ id: 'agent-a' } as Parameters<
      ReturnType<typeof useTimelineStore.getState>['setReadOnlyThread']
    >[0]);
  await screen.findByRole('button', { name: 'mcpServers · 0/1' });
  expect(mock.list).toHaveBeenCalledTimes(1);
});
