/** Real responsive layout, using fixtures only (no user repository access). */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { WorkspaceGitPanel } from './workspace-git-panel';
import { GitCopyActions } from './workspace-git-actions';
import type { GitSnapshot } from '@/lib/workspace-git-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { locationInventoryFixture } from '@/test/project-locations-fixture';
import type { GitInventory } from '@/lib/workspace-git-api';

vi.mock('@/lib/projects-api', () => ({
  projectsQueryKey: ['projects'],
  projectsApi: async (url: string) => {
    if (url.endsWith('/locations'))
      return locationInventoryFixture({
        resources: [
          {
            id: 'git',
            name: 'Dépôt de développement',
            type: 'git',
            accessMode: 'read_write',
            address: 'https://github.com/example/demo.git',
            enabled: true,
          },
        ],
        copies: [
          {
            id: 'copy',
            sourceResourceId: 'git',
            name: 'feature/une-branche-avec-un-nom-très-long',
            localPath: '/copy',
            accessMode: 'read_write',
            sourceEnabled: true,
            state: 'ready',
          },
        ],
      } as GitInventory);
    if (url.endsWith('/copies/copy'))
      return {
        branch: 'feature/une-branche-avec-un-nom-très-long',
        fingerprint: 'a'.repeat(64),
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
    if (url.endsWith('/staged-diff'))
      return {
        fingerprint: 'a'.repeat(64),
        diff: '+staged change\n'.repeat(20),
      };
    if (url.endsWith('/commits'))
      return {
        items: [
          {
            sha: 'a'.repeat(40),
            author: 'Test',
            date: '2026-10-26T12:00:00Z',
            subject: 'Modification locale du message',
          },
        ],
        limited: false,
      };
    if (url.endsWith('/branches'))
      return {
        supported: true,
        items: [
          {
            name: 'feature/publiee-sur-github',
            revision: 'b'.repeat(40),
            protected: false,
          },
        ],
        limited: false,
        inspectedAt: Date.now(),
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
      await page.getByRole('tab', { name: 'Distant · GitHub' }).click();
      await page.getByRole('button', { name: /#12/ }).click();
      await screen.findByText('En cours');
      expect(fixture.scrollWidth).toBeLessThanOrEqual(width);
      await page
        .getByRole('tab', { name: 'Synchronisation', exact: true })
        .click();
      expect(
        await screen.findByRole('region', { name: 'Synchronisation' }),
      ).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Commit…' })).toBeNull();
      expect(fixture.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-sync-${width}.png`,
      });
      await page.getByRole('tab', { name: 'Distant · GitHub' }).click();
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-panel-${width}.png`,
      });
      await page.getByRole('tab', { name: 'Branches publiées' }).click();
      expect(
        await screen.findByText('feature/publiee-sur-github'),
      ).toBeVisible();
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-remote-branches-${width}.png`,
      });
      await page.getByRole('tab', { name: 'Local', exact: true }).click();
      await page.getByRole('tab', { name: 'Commits' }).click();
      expect(
        await screen.findByText('Modification locale du message'),
      ).toBeVisible();
    } finally {
      view.unmount();
      client.clear();
    }
  },
);

test('keeps commit confirmation usable on mobile and never writes on cancel', async () => {
  await page.viewport(390, 800);
  await i18nReady;
  await i18n.changeLanguage('fr');
  const client = new QueryClient();
  const state: GitSnapshot = {
    fingerprint: 'a'.repeat(64),
    head: 'b'.repeat(40),
    branch: 'feature/long-branch-name',
    changes: [{ path: 'src/reviewed.ts', status: 'M ' }],
    branches: [],
    ahead: 0,
    behind: 0,
    upstream: null,
    branchesLimited: false,
    inspectedAt: 1,
  };
  const view = render(
    <QueryClientProvider client={client}>
      <GitCopyActions
        projectId="p"
        copyId="copy"
        snapshot={state}
        address="https://github.com/example/demo.git"
      />
    </QueryClientProvider>,
  );
  try {
    await page.getByRole('button', { name: 'Commit…', exact: true }).click();
    const dialog = await screen.findByRole('dialog');
    await screen.findByText(/staged change/);
    const bounds = dialog.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(390);
    expect(bounds.height).toBeLessThanOrEqual(800 * 0.85 + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: '../../../.vitest-screenshots/git-commit-mobile.png',
    });
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect.poll(() => screen.queryByRole('dialog')).toBeNull();
  } finally {
    view.unmount();
    client.clear();
  }
});
