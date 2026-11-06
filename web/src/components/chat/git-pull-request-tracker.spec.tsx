import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { GitPullRequestTracker } from './git-pull-request-tracker';
import { SurfaceActivityContext } from '@/lib/surface-activity';
import i18n, { i18nReady } from '@/i18n';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
vi.mock('./workspace-git-actions', () => ({
  GitMergeAction: () => <button>Fusion test</button>,
}));
afterEach(() => {
  cleanup();
  api.mockReset();
});
const list = {
  supported: true,
  limited: false,
  items: [
    {
      number: 12,
      title: 'PR disponible',
      head: 'a',
      base: 'main',
      branch: 'feature',
      draft: false,
      url: 'https://github.com/example/repo/pull/12',
    },
  ],
};
const checks = {
  head: 'a',
  draft: false,
  mergeable: true,
  mergeableState: 'clean',
  inspectedAt: 1,
  limited: false,
  items: [{ id: '1', name: 'Frontend', status: 'success' }],
};
function mount(active = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <SurfaceActivityContext.Provider value={active}>
      <QueryClientProvider client={client}>
        <GitPullRequestTracker
          projectId="p"
          resourceId="r"
          canWrite
          resourceAddress={null}
          onCloseFocus={() => {}}
        />
      </QueryClientProvider>
    </SurfaceActivityContext.Provider>,
  );
  return client;
}
it('retains the list on a network failure, marks it unconfirmed and withdraws merging', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  let offline = false;
  api.mockImplementation((url: string) =>
    url.endsWith('/pull-requests')
      ? offline
        ? Promise.reject(new Error('GIT_GITHUB_TIMEOUT'))
        : Promise.resolve(list)
      : Promise.resolve(checks),
  );
  const client = mount();
  await screen.findByText('Prête à fusionner');
  fireEvent.click(screen.getByRole('button', { name: '#12 PR disponible' }));
  await screen.findByRole('button', { name: 'Fusion test' });
  offline = true;
  await client.refetchQueries({ queryKey: ['workspace-git-prs', 'p', 'r'] });
  await screen.findByText(/Liste conservée depuis/);
  expect(
    screen.getByRole('button', { name: '#12 PR disponible' }),
  ).toBeVisible();
  expect(screen.queryByText('Prête à fusionner')).toBeNull();
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Fusion test' })).toBeNull(),
  );
  expect(screen.getAllByRole('alert')[0]).toHaveTextContent(
    'GitHub n’a pas répondu',
  );
  client.clear();
});
it('does not start GitHub polling in a retained but inactive agent view', async () => {
  await i18nReady;
  mount(false);
  await Promise.resolve();
  expect(api).not.toHaveBeenCalled();
});
