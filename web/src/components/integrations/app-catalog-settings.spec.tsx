import { it, vi, expect, afterEach } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { client } from '@/generated/api/client.gen';
import { AppCatalogSettings, type CatalogStatus } from './app-catalog-settings';
const state: CatalogStatus = {
  source: 'byparr',
  running: false,
  updatedAt: 1793534400000,
  nextAttempt: 1793620800000,
  count: 5011,
  stale: false,
  warning: true,
  history: [
    { at: 1793534400000, status: 'failed', code: 'CATALOG_DOWNLOAD_FAILED' },
    {
      at: 1793448000000,
      status: 'success',
      code: 'CATALOG_UPDATED',
      count: 5011,
    },
  ],
};
let query: QueryClient;
function mount(data = state) {
  vi.spyOn(client, 'get').mockResolvedValue({ data } as never);
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <AppCatalogSettings />
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  query?.clear();
  vi.restoreAllMocks();
});
it('warns about a failed daily update and exposes the persisted journal', async () => {
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'catalog refresh failed',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Catalog journal' }));
  expect(await screen.findByRole('table')).toBeVisible();
  expect(
    within(screen.getByRole('table')).getByText(/Download refused/),
  ).toBeVisible();
  expect(screen.getByText(/Succeeded/)).toBeVisible();
});
it('switches back to native without a download request', async () => {
  const post = vi.spyOn(client, 'post').mockResolvedValue({
    data: { ...state, source: 'native', warning: false },
  } as never);
  mount();
  const toggle = await screen.findByRole('switch');
  await screen.findByRole('alert');
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/api/apps/catalog/source',
        body: { source: 'native' },
      }),
    ),
  );
});
