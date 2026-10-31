import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ProjectAgentMonitors } from './project-agent-monitors';
import type { AgentMonitor } from '@/lib/agent-monitors-api';
import i18n, { i18nReady } from '@/i18n';

const mocks = vi.hoisted(() => ({ api: vi.fn(), admin: true }));
vi.mock('@/lib/projects-api', async (original) => ({
  ...(await original<typeof import('@/lib/projects-api')>()),
  projectsApi: mocks.api,
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    isAdministrator: mocks.admin,
    data: { kind: 'person' },
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    params,
    children,
  }: {
    params: { threadId: string };
    children: ReactNode;
  }) => <a href={`/t/${params.threadId}`}>{children}</a>,
}));
let monitor: AgentMonitor;
let failSave: boolean;
const mount = () =>
  render(
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
      <ProjectAgentMonitors projectId="p" />
    </QueryClientProvider>,
  );
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
  mocks.admin = true;
  failSave = false;
  monitor = {
    id: 'm1',
    threadId: 't1',
    name: 'Check release',
    instructions: 'Read checks without publishing.',
    intervalMs: 60_000,
    nextRunAt: Date.now() + 60_000,
    expiresAt: Date.now() + 86_400_000,
    maxRuns: 20,
    maxRunMs: 300_000,
    runCount: 1,
    accessMode: 'readOnly',
    status: 'active',
    lastReason: 'MONITOR_USER_TAKEOVER',
  };
  mocks.api
    .mockReset()
    .mockImplementation((path?: string, input?: RequestInit) => {
      if (input?.method === 'POST' && path === '/p/agent-monitors')
        return failSave
          ? Promise.reject(new Error('Unconfirmed'))
          : Promise.resolve({ monitor });
      if (path?.endsWith('/pause')) {
        monitor = { ...monitor, status: 'paused' };
        return Promise.resolve({ monitor });
      }
      if (path === '/p/agent-monitors/m1')
        return Promise.resolve({
          monitor,
          runs: [
            {
              id: 'run',
              status: 'deferred',
              claimedAt: Date.now(),
              reason: 'MONITOR_USER_TAKEOVER',
              result: 'Human conversation has priority.',
            },
          ],
        });
      if (path === '/p/agent-monitors')
        return Promise.resolve({ monitors: [monitor], activeRuns: [] });
      if (path === undefined)
        return Promise.resolve({
          projects: [
            {
              id: 'p',
              agentThreads: [
                { threadId: 't1', title: 'Release agent', archived: false },
              ],
            },
          ],
        });
      throw new Error(`Unexpected test route: ${path}`);
    });
});
afterEach(cleanup);

it('does not query privileged monitor data for a standard identity', async () => {
  mocks.admin = false;
  mount();
  await screen.findByText(/Monitor management requires an administrator/);
  expect(mocks.api).not.toHaveBeenCalled();
});

it('explains automatic continuation, opens history, and sends an explicit pause only when requested', async () => {
  mount();
  await screen.findByRole('heading', { name: 'Check release' });
  expect(screen.getByText(/You can keep talking/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Release agent' })).toHaveAttribute(
    'href',
    '/t/t1',
  );
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  await screen.findByText('Human conversation has priority.');
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await screen.findByText('Paused');
  expect(mocks.api).toHaveBeenCalledWith('/p/agent-monitors/m1/pause', {
    method: 'POST',
  });
});

it('defaults to read-only and keeps the same request identity after an unconfirmed create', async () => {
  mount();
  const create = await screen.findByRole('button', { name: 'New monitor' });
  await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create);
  fireEvent.change(screen.getByLabelText('Name'), {
    target: { value: 'Read the PR' },
  });
  fireEvent.change(screen.getByLabelText('Instructions and authorized scope'), {
    target: { value: 'Read checks, do not merge.' },
  });
  const form = screen
    .getByRole('button', { name: 'Schedule' })
    .closest('form')!;
  failSave = true;
  fireEvent.submit(form);
  await screen.findByRole('alert');
  failSave = false;
  fireEvent.submit(form);
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  const attempts = mocks.api.mock.calls
    .filter(
      ([path, input]) =>
        path === '/p/agent-monitors' &&
        (input as RequestInit | undefined)?.method === 'POST',
    )
    .map(
      ([, input]) =>
        JSON.parse((input as RequestInit).body as string) as Record<
          string,
          unknown
        >,
    );
  expect(attempts).toHaveLength(2);
  expect(attempts[0].requestId).toBe(attempts[1].requestId);
  expect(attempts[0]).toMatchObject({
    threadId: 't1',
    accessMode: 'readOnly',
    maxRuns: 20,
    maxRunMs: 300_000,
    intervalMs: 300_000,
  });
});
