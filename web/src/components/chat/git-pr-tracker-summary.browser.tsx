import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  fireEvent,
  within,
} from '@testing-library/react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { WorkspaceGitPanel } from './workspace-git-panel';
import { locationInventoryFixture } from '@/test/project-locations-fixture';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({
  projectsApi: api,
  projectsQueryKey: ['projects'],
}));
vi.mock('@/generated/api', () => ({ filesAddRoot: async () => ({}) }));
vi.mock('@/lib/file-watch-leases', () => ({
  acquireFileWatch: () => () => {},
}));
vi.mock('@/socket', () => ({
  getSocket: () => ({ on: () => {}, off: () => {} }),
}));
vi.mock('@/components/files/file-tree', () => ({
  FileTree: () => <div>Fichiers locaux</div>,
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    data: { kind: 'person', personId: 'person', name: 'Test', active: true },
    isPending: false,
    isError: false,
  }),
}));
afterEach(cleanup);
test.each([390, 1180])(
  'opens the inactive creator during CI in the actual router at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    let listOffline = false;
    api.mockImplementation((url: string, options?: RequestInit) => {
      if (listOffline && url.endsWith('/pull-requests'))
        return Promise.reject(new Error('GIT_GITHUB_TIMEOUT'));
      return Promise.resolve(
        url.endsWith('/pr-agents')
          ? { agents: [{ threadId: 'creator2', name: 'Documentation' }] }
          : options?.method === 'POST' && url.endsWith('/14/agent')
            ? {
                creator: null,
                agents: [
                  {
                    threadId: 'creator2',
                    name: 'Documentation',
                    phase: 'idle',
                    updatedAt: 1,
                  },
                ],
              }
            : url.endsWith('/locations')
              ? locationInventoryFixture({
                  resources: [
                    {
                      id: 'r',
                      projectId: 'p',
                      name: 'Git Mergeron',
                      type: 'git',
                      accessMode: 'read_write',
                      address: 'https://github.com/example/repo.git',
                      enabled: true,
                      localWorkspaceId: null,
                      localPath: null,
                      rootPath: '/',
                      capabilities: { read: true, write: true, execute: false },
                      connectionState: 'connected',
                      hasSecret: false,
                      lastCheckedAt: null,
                      lastError: null,
                    },
                  ],
                  copies: [],
                })
              : url.endsWith('/pull-requests')
                ? {
                    supported: true,
                    limited: false,
                    items: [12, 13, 14].map((number, i) => ({
                      number,
                      title: [
                        'Améliorer le classement',
                        'Corriger les documents',
                        'Simplifier la documentation',
                      ][i],
                      draft: false,
                      branch: 'feature/' + number,
                      base: 'main',
                      head: 'a',
                      url: 'https://github.com/example/repo/pull/' + number,
                      tracking:
                        i === 2
                          ? { creator: null, agents: [] }
                          : {
                              creator: {
                                threadId: 'creator' + i,
                                name: [
                                  'Agent créateur',
                                  'Correcteur',
                                  'Documentation',
                                ][i],
                              },
                              agents: [
                                {
                                  threadId: 'creator' + i,
                                  name: [
                                    'Agent créateur',
                                    'Correcteur',
                                    'Documentation',
                                  ][i],
                                  phase: i === 1 ? 'working' : 'idle',
                                  updatedAt: 1,
                                },
                              ],
                            },
                    })),
                  }
                : {
                    head: 'a',
                    draft: false,
                    mergeable: true,
                    mergeableState: 'clean',
                    limited: false,
                    inspectedAt: Date.now(),
                    items: [
                      {
                        id: '1',
                        name: 'Frontend',
                        status: url.includes('/13/')
                          ? 'failure'
                          : url.includes('/14/')
                            ? 'success'
                            : 'in_progress',
                      },
                    ],
                  },
      );
    });
    const root = createRootRoute();
    const index = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: () => (
        <aside className="ml-auto flex h-[calc(100dvh-16px)] min-h-0 w-full max-w-sm flex-col border-l bg-background text-foreground">
          <WorkspaceGitPanel
            projectId="p"
            resourceId="r"
            agentThreadId="creator0"
            cwd={null}
            activeWorkspacePending={false}
            onSelect={() => {}}
            onFile={() => {}}
          />
        </aside>
      ),
    });
    const agent = createRoute({
      getParentRoute: () => root,
      path: '/t/$threadId',
      component: () => <div>Conversation de l’agent créateur</div>,
    });
    const router = createRouter({
      routeTree: root.addChildren([index, agent]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await page.getByRole('tab', { name: 'GitHub', exact: true }).click();
    const list = await screen.findByRole('region', {
      name: 'Liste des PR ouvertes',
    });
    await within(list).findByText('En vérification');
    const link = screen.getByRole('link', { name: 'Agent créateur · Inactif' });
    expect(link.getAttribute('href')).toBe('/t/creator0');
    expect(view.container.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
    await within(list).findByText('En erreur');
    await within(list).findByText('Prête à fusionner');
    expect(within(list).queryByText('feature/12 → main')).toBeNull();
    expect(
      within(list).queryByRole('link', { name: 'Voir sur GitHub' }),
    ).toBeNull();
    expect(
      screen.queryByRole('region', { name: 'Détail de la PR #12' }),
    ).toBeNull();
    await page
      .getByRole('button', { name: '#12 Améliorer le classement', exact: true })
      .click();
    const detail = screen.getByRole('region', { name: 'Détail de la PR #12' });
    expect(
      within(detail).getByRole('heading', { name: 'Contrôles GitHub' }),
    ).toBeVisible();
    expect(
      within(detail).queryByRole('link', { name: 'Agent créateur · Inactif' }),
    ).toBeNull();
    await page
      .getByRole('button', { name: '#13 Corriger les documents', exact: true })
      .click();
    const nextDetail = await screen.findByRole('region', {
      name: 'Détail de la PR #13',
    });
    await within(nextDetail).findByText('Échec');
    expect(
      screen.getByRole('button', {
        name: '#13 Corriger les documents',
      }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(list.contains(nextDetail)).toBe(true);
    expect(
      screen.getByRole('region', { name: 'Détail de la PR #12' }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '#13 Corriger les documents', exact: true })
      .click();
    expect(
      screen.queryByRole('region', { name: 'Détail de la PR #13' }),
    ).toBeNull();
    await page
      .getByRole('button', { name: 'Agent non identifié', exact: true })
      .click();
    const picker = await screen.findByRole('dialog');
    expect(picker).toHaveTextContent('PR #14');
    await page
      .getByRole('button', { name: 'Documentation', exact: true })
      .click();
    await screen.findByRole('link', { name: 'Documentation · Inactif' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.getByRole('region', { name: 'Détail de la PR #12' }),
    ).toBeVisible();
    await page.screenshot({
      path: `../../../.vitest-screenshots/pr-tracker-${width}.png`,
    });
    listOffline = true;
    await client.refetchQueries({ queryKey: ['workspace-git-prs', 'p', 'r'] });
    await screen.findByText(/Liste conservée depuis/);
    expect(screen.queryByText('Prête à fusionner')).toBeNull();
    expect(
      screen.getByRole('button', { name: '#12 Améliorer le classement' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Fusionner la PR…' }),
    ).toBeNull();
    await page.screenshot({
      path: `../../../.vitest-screenshots/pr-tracker-stale-${width}.png`,
    });
    fireEvent.click(link);
    await screen.findByText('Conversation de l’agent créateur');
    expect(router.state.location.pathname).toBe('/t/creator0');
    client.clear();
  },
);
