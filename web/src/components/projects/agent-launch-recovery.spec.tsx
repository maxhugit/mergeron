import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentLaunchRecovery } from './agent-launch-recovery';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: true }),
}));
afterEach(cleanup);
beforeEach(() => api.mockReset());
const initial = {
  id: 'receipt',
  resourceId: 'r',
  phase: 'creating',
  state: 'needs_attention',
  threadId: null as string | null,
  revision: 10,
  targetRevision: 42,
  busy: false,
};
function show(
  launch = initial,
  candidates = [{ id: 'existing', title: 'Recovered conversation' }],
) {
  const open = vi.fn(),
    recovered = vi.fn();
  api.mockImplementation((_path, init) =>
    Promise.resolve(init ? {} : { launch, candidates }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AgentLaunchRecovery
        projectId="p"
        resourceId="r"
        kind="task"
        targetId="task"
        onOpen={open}
        onRecovered={recovered}
      />
    </QueryClientProvider>,
  );
  return { open, recovered };
}
it('recovers an unknown allocation only after explicitly selecting an existing agent with observed revisions', async () => {
  const { recovered } = show();
  const attach = await screen.findByRole('button', {
    name: 'Associate this existing agent',
  });
  expect(attach).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: 'existing' },
  });
  fireEvent.click(attach);
  await waitFor(() => expect(recovered).toHaveBeenCalledOnce());
  const post = api.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(post![0]).toBe('/p/resources/r/agent-launches/receipt/recover');
  expect(JSON.parse(post![1].body)).toEqual({
    action: 'attach',
    threadId: 'existing',
    expectedUpdatedAt: 10,
    targetRevision: 42,
  });
});
it('requires confirmation that the conversation was checked before acknowledging an uncertain send', async () => {
  const { open } = show({
    ...initial,
    phase: 'dispatching',
    threadId: 'existing',
  });
  const acknowledge = await screen.findByRole('button', {
    name: 'Confirm check',
  });
  expect(acknowledge).toBeDisabled();
  expect(
    screen.queryByRole('button', { name: 'Finish association' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open agent' }));
  expect(open).toHaveBeenCalledExactlyOnceWith('existing');
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(acknowledge);
  await waitFor(() =>
    expect(api.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(
      true,
    ),
  );
  expect(
    JSON.parse(
      api.mock.calls.find(([, init]) => init?.method === 'POST')![1].body,
    ).action,
  ).toBe('acknowledge');
});
it('only offers association completion for a known agent and never asks the server to send a turn', async () => {
  show({ ...initial, phase: 'created', threadId: 'existing' });
  fireEvent.click(
    await screen.findByRole('button', { name: 'Finish association' }),
  );
  await waitFor(() =>
    expect(api.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(
      true,
    ),
  );
  const paths = api.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([path]) => path);
  expect(paths).toEqual(['/p/resources/r/agent-launches/receipt/recover']);
});
it('keeps the recovery visible after a conflict and lets the user refresh', async () => {
  show({ ...initial, phase: 'created', threadId: 'existing' });
  const base = api.getMockImplementation()!;
  api.mockImplementation((path, init) =>
    init ? Promise.reject(new Error('Conflict')) : base(path, init),
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Finish association' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Recovery was not confirmed',
  );
  expect(
    screen.getByRole('button', { name: 'Refresh check' }),
  ).toBeInTheDocument();
});
it('blocks recovery while the original request is still in flight', async () => {
  show({ ...initial, busy: true, state: 'pending' });
  await screen.findByText(
    'This request is still running. Wait for confirmation before taking action.',
  );
  expect(
    screen.queryByRole('button', { name: 'Associate this existing agent' }),
  ).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('only closes an unfinished association after explicit verification and preserves the known agent', async () => {
  show({ ...initial, phase: 'created', threadId: 'existing' });
  const keep = await screen.findByRole('button', {
    name: 'Keep agent without finishing the association',
  });
  expect(keep).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(keep);
  await waitFor(() =>
    expect(api.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(
      true,
    ),
  );
  const post = api.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(post![1].body)).toMatchObject({
    action: 'keep',
    verified: true,
    expectedUpdatedAt: 10,
  });
});
