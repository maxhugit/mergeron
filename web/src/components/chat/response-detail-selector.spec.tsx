import {
  act,
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

function mount(disabled = false) {
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
      <ResponseDetailSelector disabled={disabled} />
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
  const select = screen.getByRole('button', { name: /^Technical details/ });
  await waitFor(() => expect(select).toBeEnabled());
  expect(select).toHaveTextContent('Collapsed details');
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Display setting for this agent/),
  ).not.toBeInTheDocument();
  fireEvent.click(select);
  const dialog = screen.getByRole('dialog', { name: 'Technical details' });
  expect(dialog.querySelectorAll('button')).toHaveLength(3);
  fireEvent.click(
    screen.getByRole('button', { name: 'Hide technical details' }),
  );
  await waitFor(() =>
    expect(select).toHaveTextContent('Hide technical details'),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  act(() => useTimelineStore.setState({ threadId: 'b' }));
  await waitFor(() => expect(select).toBeEnabled());
  expect(select).toHaveTextContent('Collapsed details');
  fireEvent.click(select);
  fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
  await waitFor(() => expect(select).toHaveTextContent('Show everything'));
  view.unmount();
  mount();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: /^Technical details/ }),
    ).toHaveTextContent('Hide technical details'),
  );
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH'),
  ).toHaveLength(2);
});

it('keeps the menu disabled while loading, explicitly disabled, or without an agent', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ mode: 'collapsed' })),
  );
  mount(true);
  const trigger = screen.getByRole('button', { name: /^Technical details/ });
  expect(trigger).toBeDisabled();
  await waitFor(() => expect(trigger).toHaveTextContent('Collapsed details'));
  fireEvent.click(trigger);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  act(() => useTimelineStore.setState({ threadId: null }));
  expect(trigger).toBeDisabled();
});

it('does not claim a preference was saved when the server rejects it', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (_url, init) =>
      new Response(JSON.stringify({ mode: 'collapsed' }), {
        status: init?.method === 'PATCH' ? 500 : 200,
      }),
  );
  mount();
  const select = screen.getByRole('button', { name: /^Technical details/ });
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.click(select);
  fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(select).toHaveTextContent('Collapsed details');
  expect(select).toBeEnabled();
});
