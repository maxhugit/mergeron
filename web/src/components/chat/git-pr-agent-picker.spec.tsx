import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { GitPrAgentPicker } from './git-pr-agent-picker';
import i18n, { i18nReady } from '@/i18n';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
afterEach(cleanup);

it('loads project agents only when opened and associates without starting the agent', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(['workspace-git-prs', 'p', 'r'], {
    supported: true,
    limited: false,
    items: [{ number: 12 }],
  });
  api.mockImplementation((_url: string, options?: RequestInit) =>
    Promise.resolve(
      options?.method === 'POST'
        ? {
            creator: null,
            agents: [
              {
                threadId: 'agent',
                name: 'Merlin',
                phase: 'idle',
                updatedAt: 1,
              },
            ],
          }
        : { agents: [{ threadId: 'agent', name: 'Merlin' }] },
    ),
  );
  render(
    <QueryClientProvider client={client}>
      <GitPrAgentPicker projectId="p" resourceId="r" number={12} />
    </QueryClientProvider>,
  );
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Agent non identifié' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Merlin' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api).toHaveBeenCalledWith(
    '/p/git/connections/r/pull-requests/12/agent',
    { method: 'POST', body: JSON.stringify({ threadId: 'agent' }) },
  );
  expect(client.getQueryData(['workspace-git-prs', 'p', 'r'])).toMatchObject({
    items: [
      {
        number: 12,
        tracking: {
          creator: null,
          agents: [{ threadId: 'agent', phase: 'idle' }],
        },
      },
    ],
  });
  expect(api.mock.calls.every(([url]) => !String(url).includes('/turn'))).toBe(
    true,
  );
});

it('keeps the picker open and reports assignment failure', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  api.mockReset();
  api.mockImplementation((_url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? Promise.reject(new Error('denied'))
      : Promise.resolve({ agents: [{ threadId: 'agent', name: 'Merlin' }] }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <GitPrAgentPicker projectId="p" resourceId="r" number={12} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Agent non identifié' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Merlin' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Affectation impossible',
  );
  expect(screen.getByRole('dialog')).toBeVisible();
});
