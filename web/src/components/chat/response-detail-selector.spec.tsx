import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { useTimelineStore } from '@/stores/timeline-store';
import { ResponseDetailSelector } from './response-detail-selector';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useTimelineStore.setState({ threadId: null });
});

function mount() {
  useTimelineStore.setState({ threadId: 'a' });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <ResponseDetailSelector />
    </QueryClientProvider>,
  );
}

it('offers three modes, saves per agent and restores them after remounting', async () => {
  const modes: Record<string, string> = {};
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url, init) => {
      const id = String(url).includes('/a/') ? 'a' : 'b';
      if (init?.method === 'PATCH')
        modes[id] = JSON.parse(init.body as string).mode;
      return new Response(JSON.stringify({ mode: modes[id] ?? 'collapsed' }));
    });
  const view = mount();
  const select = screen.getByRole('combobox', { name: 'Technical details' });
  await waitFor(() => expect(select).toBeEnabled());
  expect(select).toHaveValue('collapsed');
  expect(screen.getAllByRole('option')).toHaveLength(3);
  fireEvent.change(select, { target: { value: 'hidden' } });
  await waitFor(() => expect(select).toHaveValue('hidden'));
  useTimelineStore.setState({ threadId: 'b' });
  await waitFor(() => expect(select).toBeEnabled());
  expect(select).toHaveValue('collapsed');
  fireEvent.change(select, { target: { value: 'expanded' } });
  await waitFor(() => expect(select).toHaveValue('expanded'));
  view.unmount();
  mount();
  await waitFor(() =>
    expect(screen.getByRole('combobox')).toHaveValue('hidden'),
  );
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH'),
  ).toHaveLength(2);
});

it('does not claim a preference was saved when the server rejects it', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (_url, init) =>
      new Response(JSON.stringify({ mode: 'collapsed' }), {
        status: init?.method === 'PATCH' ? 500 : 200,
      }),
  );
  mount();
  const select = screen.getByRole('combobox');
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: 'expanded' } });
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(select).toHaveValue('collapsed');
  expect(select).toBeEnabled();
});
