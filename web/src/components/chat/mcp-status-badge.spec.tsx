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
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mock.list.mockReset();
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
