import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { client } from '@/generated/api/client.gen';
import { IntegrationsPanel } from './integrations-panel';
import { PluginsTab } from './plugins-tab';
import { TooltipProvider } from '@/components/ui/tooltip';

const plugin = {
  id: 'docs',
  name: 'Documents',
  source: {},
  installed: true,
  enabled: true,
  installPolicy: 'AVAILABLE',
  authPolicy: 'ON_USE',
  interface: null,
};
const plugins = {
  marketplaces: [
    { name: 'local', path: '/plugins', interface: null, plugins: [plugin] },
  ],
  marketplaceLoadErrors: [],
  featuredPluginIds: ['docs'],
  remoteSyncError: null,
};
let query: QueryClient;
const spyGet = () => vi.spyOn(client, 'get');
let get: ReturnType<typeof spyGet>;
function mount() {
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <TooltipProvider>
        <IntegrationsPanel />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  get = spyGet().mockImplementation(async (options) => {
    const url = options.url;
    if (options.url === '/api/apps/catalog/status')
      return {
        data: {
          source: 'native',
          running: false,
          updatedAt: null,
          nextAttempt: null,
          count: 0,
          stale: false,
          warning: false,
          history: [],
        },
      } as never;
    if (url === '/api/plugins' || url === '/api/plugins/installed')
      return { data: plugins } as never;
    if (url === '/api/apps/installed')
      return {
        data: {
          apps: [
            {
              id: 'home',
              runtimeName: 'Home Assistant',
              enabled: true,
              callable: true,
            },
          ],
        },
      } as never;
    if (url === '/api/apps')
      return { data: { data: [], nextCursor: null } } as never;
    if (url === '/api/mcp-servers')
      return {
        data: {
          data: [{ name: 'custom', authStatus: 'notLoggedIn', tools: {} }],
          nextCursor: null,
        },
      } as never;
    if (url === '/api/codex/config')
      return { data: { config: {}, origins: {} } } as never;
    throw Error('Unexpected request: ' + url);
  });
});
afterEach(() => {
  cleanup();
  query?.clear();
  vi.restoreAllMocks();
});
it('loads installed bundles first and only requests the marketplace when selected', async () => {
  mount();
  expect(await screen.findByText('Documents')).toBeVisible();
  expect(get.mock.calls.map(([o]) => o.url)).toEqual([
    '/api/plugins/installed',
  ]);
  fireEvent.click(screen.getByRole('tab', { name: 'Featured' }));
  await waitFor(() =>
    expect(get.mock.calls.some(([o]) => o.url === '/api/plugins')).toBe(true),
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Installed and built-in' }));
  expect(await screen.findByText('Documents')).toBeVisible();
  expect(
    get.mock.calls.filter(([o]) => o.url === '/api/plugins/installed'),
  ).toHaveLength(1);
});
it('separates connected apps from the catalog', async () => {
  mount();
  await screen.findByText('Documents');
  fireEvent.click(screen.getByRole('tab', { name: 'Applications' }));
  expect(await screen.findByText('Home Assistant')).toBeVisible();
  expect(get.mock.calls.some(([o]) => o.url === '/api/apps')).toBe(false);
  fireEvent.click(screen.getByRole('tab', { name: 'Catalog' }));
  await waitFor(() =>
    expect(get.mock.calls.some(([o]) => o.url === '/api/apps')).toBe(true),
  );
});
it('cancels an abandoned catalog request and opens server configuration in a modal', async () => {
  let signal: AbortSignal | undefined;
  const original = get.getMockImplementation()!;
  get.mockImplementation((options, ...rest) => {
    if (options.url === '/api/plugins') {
      signal = options.signal as AbortSignal;
      return new Promise((_, reject) =>
        signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        ),
      ) as never;
    }
    return original(options, ...rest);
  });
  mount();
  await screen.findByText('Documents');
  fireEvent.click(screen.getByRole('tab', { name: 'Catalog' }));
  await waitFor(() => expect(signal).toBeDefined());
  fireEvent.click(screen.getByRole('tab', { name: 'MCP servers' }));
  await waitFor(() => expect(signal?.aborted).toBe(true));
  fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
  expect(
    await screen.findByRole('dialog', { name: 'Add server' }),
  ).toBeVisible();
});

it('does not repeatedly fetch a refused directory when revisiting the category', async () => {
  const original = get.getMockImplementation()!;
  get.mockImplementation((options, ...rest) =>
    options.url === '/api/apps'
      ? Promise.reject({ message: '403 <html>upstream challenge</html>' })
      : original(options, ...rest),
  );
  mount();
  await screen.findByText('Documents');
  fireEvent.click(screen.getByRole('tab', { name: 'Applications' }));
  await screen.findByText('Home Assistant');
  fireEvent.click(screen.getByRole('tab', { name: 'Catalog' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('tab', { name: 'Connected' }));
  await screen.findByText('Home Assistant');
  fireEvent.click(screen.getByRole('tab', { name: 'Catalog' }));
  await screen.findByRole('alert');
  expect(
    get.mock.calls.filter(([options]) => options.url === '/api/apps'),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() =>
    expect(
      get.mock.calls.filter(([options]) => options.url === '/api/apps'),
    ).toHaveLength(2),
  );
});

it.each([
  ['/plugins', undefined],
  [null, 'remote'],
])(
  'opens details using the marketplace identity (%s)',
  async (path, remote) => {
    get.mockImplementation(async (options) => {
      if (options.url === '/api/plugins/installed')
        return {
          data: {
            ...plugins,
            marketplaces: [
              { name: 'remote', path, interface: null, plugins: [plugin] },
            ],
          },
        } as never;
      if (options.url === '/api/plugins/detail')
        return {
          data: {
            plugin: {
              marketplaceName: 'remote',
              marketplacePath: path,
              summary: plugin,
              description: 'Plugin details loaded',
              skills: [],
              apps: [],
              mcpServers: [],
            },
          },
        } as never;
      throw Error('Unexpected request');
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    expect(await screen.findByText('Plugin details loaded')).toBeVisible();
    expect(
      get.mock.calls.find(([o]) => o.url === '/api/plugins/detail')?.[0].query,
    ).toEqual(
      path
        ? { marketplacePath: path, pluginName: 'Documents' }
        : { remoteMarketplaceName: remote, pluginName: 'Documents' },
    );
  },
);

it('reports a failed detail request and permits an explicit retry', async () => {
  const original = get.getMockImplementation()!;
  get.mockImplementation((options, ...rest) =>
    options.url === '/api/plugins/detail'
      ? Promise.reject(new Error('unavailable'))
      : original(options, ...rest),
  );
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Failed to load plugins',
  );
  expect(screen.queryByText('Plugin not found')).not.toBeInTheDocument();
  expect(
    get.mock.calls.filter(([o]) => o.url === '/api/plugins/detail'),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() =>
    expect(
      get.mock.calls.filter(([o]) => o.url === '/api/plugins/detail'),
    ).toHaveLength(2),
  );
});

// The internal server is created per conversation, not by the global CLI inventory.
it('shows the internal MCP separately even when the global inventory fails', async () => {
  const original = get.getMockImplementation()!;
  get.mockImplementation((options, ...rest) =>
    options.url === '/api/mcp-servers'
      ? Promise.reject(new Error('inventory unavailable'))
      : original(options, ...rest),
  );
  mount();
  await screen.findByText('Documents');
  fireEvent.click(screen.getByRole('tab', { name: 'MCP servers' }));
  expect(await screen.findByText('Mergeron (internal)')).toBeVisible();
  expect(screen.getByText('Per conversation')).toBeVisible();
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Add server' })).toBeVisible();
  expect(screen.queryByText(/external servers ready/)).toBeNull();
});

it('keeps an official plugin catalog available when the application directory refuses the request', async () => {
  const original = get.getMockImplementation()!;
  const post = vi.spyOn(client, 'post');
  get.mockImplementation((options, ...rest) =>
    options.url === '/api/apps'
      ? Promise.reject({ errorCode: 'codex.rpc_error', statusCode: 502 })
      : original(options, ...rest),
  );
  mount();
  await screen.findByText('Documents');
  fireEvent.click(screen.getByRole('tab', { name: 'Applications' }));
  await screen.findByText('Home Assistant');
  fireEvent.click(screen.getByRole('tab', { name: 'Catalog' }));
  expect(await screen.findByText('Documents')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent(
    'separate from the ChatGPT directory',
  );
  expect(
    screen.getByRole('link', { name: 'Open ChatGPT directory' }),
  ).toHaveAttribute('href', 'https://chatgpt.com/apps');
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'Connected' }));
  expect(await screen.findByText('Home Assistant')).toBeVisible();
});

it('renders at most fifty catalog rows and searches the full catalog', async () => {
  get.mockResolvedValue({
    data: {
      ...plugins,
      marketplaces: [
        {
          name: 'remote',
          path: null,
          interface: null,
          plugins: Array.from({ length: 101 }, (_, i) => ({
            ...plugin,
            id: 'plugin-' + i,
            name: 'Integration ' + i,
          })),
        },
      ],
    },
  } as never);
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <TooltipProvider>
        <PluginsTab catalogOnly />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('Integration 0');
  expect(screen.getAllByRole('button', { name: 'Manage' })).toHaveLength(50);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByText('Integration 50')).toBeVisible();
  expect(screen.queryByText('Integration 0')).toBeNull();
  fireEvent.change(screen.getByPlaceholderText('Search plugins...'), {
    target: { value: 'Integration 100' },
  });
  expect(await screen.findByText('Integration 100')).toBeVisible();
  expect(screen.getAllByRole('button', { name: 'Manage' })).toHaveLength(1);
});
