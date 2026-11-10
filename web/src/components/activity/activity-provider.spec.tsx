import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActivityProvider } from './activity-provider';
import { useActivity } from './activity-state';
import { useConnectionStore } from '@/stores/connection-store';
const session = vi.hoisted(() => ({ paused: false }));
vi.mock('@/lib/session-recovery', () => ({
  useSessionPaused: () => session.paused,
}));
const snapshot = {
  agents: {
    running: 2,
    waiting: 0,
    total: 2,
    items: [],
    stale: false,
    refreshedAt: 1,
  },
  operations: { total: 0, items: [] },
  installation: {
    environment: 'production',
    version: '0.7.5',
    channel: 'stable',
  },
};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
  localStorage.clear();
  session.paused = false;
});
function View() {
  const state = useActivity()!;
  return (
    <>
      <output>
        {state.connection}:{state.data?.agents.running ?? 'unknown'}:
        {String(state.tabletBar)}
      </output>
      <button onClick={() => state.setTabletBar(false)}>Hide</button>
      {state.preferenceError && <span>Preference failed</span>}
    </>
  );
}
function setup(owner: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const element = (scope: string) => (
    <QueryClientProvider client={client}>
      <ActivityProvider owner={scope}>
        <View />
      </ActivityProvider>
    </QueryClientProvider>
  );
  return { ...render(element(owner)), element, client };
}
it('isolates late responses and tablet preferences when the identity changes', async () => {
  let resolveAlice!: (value: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveAlice = resolve;
        }),
    )
    .mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ...snapshot,
            agents: { ...snapshot.agents, running: 8 },
          }),
        ),
      ),
    );
  vi.stubGlobal('fetch', fetch);
  useConnectionStore.setState({ connected: true });
  const { rerender, element, client } = setup('alice');
  fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
  expect(screen.getByText('connected:unknown:false')).toBeTruthy();
  rerender(element('bob'));
  await waitFor(() =>
    expect(screen.getByText('connected:8:true')).toBeTruthy(),
  );
  resolveAlice(new Response(JSON.stringify(snapshot)));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(screen.getByText('connected:8:true')).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][1]).toMatchObject({
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
  });
});
it('does not present an unavailable read as zero agents', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('', { status: 503 })),
  );
  const { client } = setup('alice');
  await waitFor(() =>
    expect(client.getQueryState(['platform-activity', 'alice'])?.status).toBe(
      'error',
    ),
  );
  expect(screen.getByText(/unknown/)).toBeTruthy();
  expect(screen.queryByText(/:0:/)).toBeNull();
});
it('does not read or disclose cached data while the session is paused', () => {
  session.paused = true;
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  useConnectionStore.setState({ connected: true });
  setup('alice');
  expect(screen.getByText('reconnecting:unknown:true')).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});
it('reports a blocked preference save while retaining the choice for this visit', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot))),
  );
  const setter = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw Error('blocked');
    });
  setup('alice');
  fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
  expect(screen.getByText(/:false/)).toBeTruthy();
  expect(screen.getByText('Preference failed')).toBeTruthy();
  setter.mockRestore();
});
