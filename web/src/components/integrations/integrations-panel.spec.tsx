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
