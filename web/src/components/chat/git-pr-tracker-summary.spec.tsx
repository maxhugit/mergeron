import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { GitPrTrackerSummary } from './git-pr-tracker-summary';
import type { GitChecks, GitPullRequests } from '@/lib/workspace-git-api';
import i18n, { i18nReady } from '@/i18n';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    params,
    children,
    ...props
  }: {
    params: { threadId: string };
    children: React.ReactNode;
  }) => (
    <a {...props} href={'/t/' + params.threadId}>
      {children}
    </a>
  ),
}));
afterEach(cleanup);
const pr: GitPullRequests['items'][number] = {
  number: 12,
  title: 'Change',
  head: 'a',
  branch: 'feature',
  base: 'main',
  draft: false,
  url: 'https://github.com/example/repo/pull/12',
  tracking: {
    creator: { threadId: 'creator', name: 'Créateur' },
    agents: [
      { threadId: 'creator', name: 'Créateur', phase: 'idle', updatedAt: 1 },
      {
        threadId: 'worker',
        name: 'Correcteur',
        phase: 'working',
        updatedAt: 2,
      },
    ],
  },
};
const checks: GitChecks = {
  head: 'a',
  draft: false,
  mergeable: true,
  mergeableState: 'clean',
  limited: false,
  inspectedAt: 1,
  items: [{ id: '1', name: 'test', status: 'queued' }],
};
function mount(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  render(
    <QueryClientProvider client={client}>
      <GitPrTrackerSummary projectId="p" resourceId="r" pr={pr} />
    </QueryClientProvider>,
  );
}
it('keeps an inactive creator clickable while checks run, separately from the current worker', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  api.mockResolvedValue(checks);
  mount();
  await screen.findByText('En vérification');
  expect(
    screen.getByRole('link', { name: 'Créateur · Inactif' }),
  ).toHaveAttribute('href', '/t/creator');
  expect(
    screen.getByRole('link', { name: 'Correcteur · Travaille sur cette PR' }),
  ).toHaveAttribute('href', '/t/worker');
  expect(screen.queryByText('Ouvrir l’agent')).not.toBeInTheDocument();
});
it('does not retain a green badge after refresh fails', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  api.mockRejectedValue(new Error('offline'));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(['workspace-git-checks', 'p', 'r', 12], {
    ...checks,
    items: [{ id: '1', name: 'test', status: 'success' }],
  });
  mount(client);
  await screen.findByText('État non confirmé');
  expect(screen.queryByText('Prête à fusionner')).not.toBeInTheDocument();
});
