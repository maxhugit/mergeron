/** Real responsive layout, using fixtures only (no user repository access). */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { WorkspaceGitPanel } from './workspace-git-panel';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

vi.mock('@/lib/projects-api', () => ({
  projectsQueryKey: ['projects'],
  projectsApi: async (url: string) => {
    if (url.endsWith('/workspace-resources'))
      return {
        resources: [
          {
            id: 'git',
            name: 'Dépôt de développement',
            type: 'git',
            enabled: true,
          },
        ],
        copies: [
          {
            id: 'copy',
            sourceResourceId: 'git',
            name: 'feature/une-branche-avec-un-nom-très-long',
            localPath: '/copy',
            sourceEnabled: true,
            state: 'ready',
          },
        ],
      };
    if (url.endsWith('/copies/copy'))
      return {
        branch: 'feature/une-branche-avec-un-nom-très-long',
        head: 'a'.repeat(40),
        ahead: 2,
        behind: 1,
        upstream: 'origin/main',
        changes: [
          {
            path: 'src/components/un-fichier-avec-un-nom-extrêmement-long.tsx',
            status: ' M',
          },
        ],
        branches: [],
        inspectedAt: 1,
      };
    if (url.endsWith('/pull-requests'))
      return {
        supported: true,
        items: [
          {
            number: 12,
            title: 'Une proposition de modification avec un titre très long',
            branch: 'feature/une-branche-avec-un-nom-très-long',
            base: 'main',
            url: 'https://github.com/example/demo/pull/12',
          },
        ],
      };
    if (url.endsWith('/checks'))
      return {
        head: 'a'.repeat(40),
        mergeable: null,
        items: [
          {
            id: 'check-1',
            name: 'Vérification des fonctionnalités principales et secondaires',
            status: 'in_progress',
          },
        ],
      };
    throw new Error('Unexpected fixture request');
  },
}));
afterEach(cleanup);
test.each([260, 330, 600])(
  'fits the Git panel at %ipx without clipping its controls',
  async (width) => {
    await page.viewport(width + 40, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <div
          data-git-fixture
          className="dark flex h-[850px] flex-col bg-background text-foreground"
          style={{ width }}
        >
          <WorkspaceGitPanel
            projectId="p"
            resourceId="git"
            onSelect={() => {}}
            cwd="/original"
            onActiveWorkspaceChange={() => {}}
            activeWorkspacePending={false}
            onFile={() => {}}
          >
            <div>Local</div>
          </WorkspaceGitPanel>
        </div>
      </QueryClientProvider>,
    );
    try {
      await screen.findByRole('button', { name: 'Parcourir les fichiers' });
      await page.getByRole('tab', { name: /Modifications/ }).click();
      await screen.findByRole('button', { name: /un-fichier/ });
      const fixture =
        document.querySelector<HTMLElement>('[data-git-fixture]')!;
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-changes-${width}.png`,
      });
      const overflowing = Array.from(fixture.querySelectorAll<HTMLElement>('*'))
        .filter(
          (item) =>
            item.getBoundingClientRect().right > width + 1 &&
            item.clientWidth > 0,
        )
        .map(
          (item) =>
            `${item.tagName}.${item.className}: ${item.getBoundingClientRect().right}`,
        );
      expect(overflowing).toEqual([]);
      expect(fixture.scrollWidth).toBeLessThanOrEqual(width);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        width + 40,
      );
      for (const tab of screen.getAllByRole('tab')) {
        const bounds = tab.getBoundingClientRect();
        expect(bounds.right).toBeLessThanOrEqual(width);
        expect(bounds.bottom).toBeLessThan(850);
      }
      await page.getByRole('tab', { name: 'PR / checks' }).click();
      await page.getByRole('button', { name: /#12/ }).click();
      await screen.findByText('En cours');
      expect(fixture.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-panel-${width}.png`,
      });
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
