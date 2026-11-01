/** Real responsive layout, using fixtures only (no user repository access). */
import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { WorkspaceGitPanel } from './workspace-git-panel';
vi.mock('@/generated/api', () => ({ filesAddRoot: async () => ({}) }));
vi.mock('@/lib/file-watch-leases', () => ({
  acquireFileWatch: () => () => {},
}));
vi.mock('@/socket', () => ({
  getSocket: () => ({ on: () => {}, off: () => {} }),
}));
vi.mock('@/components/files/file-tree', () => ({
  FileTree: () => <div>Arborescence locale</div>,
}));
import { GitCopyActions } from './workspace-git-actions';
import { GitLocalBranchActions } from './git-local-branch-actions';
import type { GitSnapshot } from '@/lib/workspace-git-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { locationInventoryFixture } from '@/test/project-locations-fixture';
import { waitForDialogClose } from '@/test/wait-for-dialog-close';
import type { GitInventory } from '@/lib/workspace-git-api';

const localFixture = vi.hoisted(() => ({
  changes: null as GitSnapshot['changes'] | null,
}));

vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    data: {
      kind: 'person',
      personId: 'person',
      name: 'Utilisateur Test',
      email: 'test@example.invalid',
      active: true,
    },
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn().mockResolvedValue({}),
  }),
}));
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
        changes: localFixture.changes ?? [
          {
            path: 'src/components/un-fichier-avec-un-nom-extrêmement-long.tsx',
            status: ' M',
          },
        ],
        branches: [
          {
            name: 'main',
            revision: 'b'.repeat(40),
            remote: false,
            upstream: '',
            tracking: '',
          },
        ],
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
          { name: 'main', revision: 'a'.repeat(40), protected: true },
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
afterEach(() => {
  cleanup();
  localFixture.changes = null;
});

test.each([
  [280, 650],
  [440, 850],
  [700, 520],
])(
  'keeps two independently scrolling change lists bounded at %ipx by %ipx',
  async (width, height) => {
    await page.viewport(width + 40, height + 40);
    await i18nReady;
    await i18n.changeLanguage('fr');
    localFixture.changes = [
      { path: 'src/mixed.ts', status: 'MM' },
      ...Array.from({ length: 40 }, (_, index) => ({
        path: `src/unprepared-${index}.ts`,
        status: ' M',
      })),
      ...Array.from({ length: 40 }, (_, index) => ({
        path: `src/prepared-${index}.ts`,
        status: 'M ',
      })),
    ];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const onDiff = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <div
          data-git-split-fixture
          className="dark flex flex-col bg-background text-foreground"
          style={{ width, height }}
        >
          <WorkspaceGitPanel
            projectId="p"
            resourceId="git"
            cwd="/original"
            onSelect={() => {}}
            onFile={() => {}}
            onGitDiff={onDiff}
            onActiveWorkspaceChange={() => {}}
            activeWorkspacePending={false}
          >
            <div>Local</div>
          </WorkspaceGitPanel>
        </div>
      </QueryClientProvider>,
    );
    try {
      await page.getByRole('tab', { name: /Modifications/ }).click();
      const upper = await screen.findByRole('region', {
        name: 'Modifications à préparer (41)',
      });
      const lower = screen.getByRole('region', {
        name: 'Prêtes pour le commit (41)',
      });
      const upperList = within(upper).getByRole('list');
      const lowerList = within(lower).getByRole('list');
      const toolbar = screen.getByRole('button', {
        name: 'Commit…',
      });
      const stageSelected = within(upper).getByRole('button', {
        name: 'Préparer la sélection',
      });
      const upperHeader = within(upper).getByRole('heading').parentElement!;
      const lowerHeader = within(lower).getByRole('heading').parentElement!;
      expect(upperHeader).toContainElement(stageSelected);
      expect(lowerHeader).toContainElement(toolbar);
      expect(stageSelected.textContent).toBe('');
      expect(toolbar.textContent).toBe('');
      expect(stageSelected).toBeEnabled();
      expect(toolbar).toBeEnabled();
      expect(screen.queryByText(/Préparez les fichiers à inclure/)).toBeNull();
      for (const [header, button] of [
        [upperHeader, stageSelected],
        [lowerHeader, toolbar],
      ]) {
        const headerBounds = header.getBoundingClientRect();
        const buttonBounds = button.getBoundingClientRect();
        expect(
          Math.abs(headerBounds.right - buttonBounds.right),
        ).toBeLessThanOrEqual(9);
        expect(buttonBounds.top).toBeGreaterThanOrEqual(headerBounds.top);
        expect(buttonBounds.bottom).toBeLessThanOrEqual(headerBounds.bottom);
      }
      expect(
        screen.queryByText(i18n.t('gitActionStagedHelp', { ns: 'workspaces' })),
      ).toBeNull();
      expect(upperList.scrollHeight).toBeGreaterThan(upperList.clientHeight);
      expect(lowerList.scrollHeight).toBeGreaterThan(lowerList.clientHeight);
      expect(upperList.clientHeight).toBeGreaterThan(20);
      expect(lowerList.clientHeight).toBeGreaterThan(20);
      const upperBounds = upper.getBoundingClientRect();
      const lowerBounds = lower.getBoundingClientRect();
      const toolbarTop = toolbar.getBoundingClientRect().top;
      expect(
        Math.abs(upperBounds.height - lowerBounds.height),
      ).toBeLessThanOrEqual(1);
      expect(upperBounds.bottom).toBeLessThan(lowerBounds.top);
      expect(lowerBounds.bottom).toBeLessThanOrEqual(height);
      fireEvent.click(
        within(upperList).getByRole('button', { name: /mixed.ts/ }),
      );
      fireEvent.click(
        within(lowerList).getByRole('button', { name: /mixed.ts/ }),
      );
      expect(
        onDiff.mock.calls.map(([target]) => [target.path, target.staged]),
      ).toEqual([
        ['src/mixed.ts', false],
        ['src/mixed.ts', true],
      ]);
      upperList.scrollTop = upperList.scrollHeight;
      await new Promise(requestAnimationFrame);
      expect(upperList.scrollTop).toBeGreaterThan(0);
      expect(lowerList.scrollTop).toBe(0);
      expect(upper.getBoundingClientRect().top).toBe(upperBounds.top);
      expect(lower.getBoundingClientRect().top).toBe(lowerBounds.top);
      expect(toolbar.getBoundingClientRect().top).toBe(toolbarTop);
      expect(stageSelected.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        upperBounds.bottom,
      );
      upperList.scrollTop = 0;
      lowerList.scrollTop = lowerList.scrollHeight;
      await new Promise(requestAnimationFrame);
      expect(upperList.scrollTop).toBe(0);
      expect(lowerList.scrollTop).toBeGreaterThan(0);
      expect(lower.getBoundingClientRect().bottom).toBe(lowerBounds.bottom);
      const fixture = document.querySelector<HTMLElement>(
        '[data-git-split-fixture]',
      )!;
      expect(fixture.scrollHeight).toBeLessThanOrEqual(height);
      expect(fixture.scrollWidth).toBeLessThanOrEqual(width);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        width + 40,
      );
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-split-changes-${width}-${height}.png`,
      });
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
test.each([330, 600])(
  'local branch confirmation fits at %ipx',
  async (width) => {
    await page.viewport(width, 800);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const branch = {
      name: 'feature/une-branche-locale-très-longue',
      revision: 'b'.repeat(40),
      remote: false,
      upstream: '',
      tracking: '',
    };
    const snapshot: GitSnapshot = {
      fingerprint: 'reviewed',
      branch: 'main',
      head: 'a'.repeat(40),
      changes: [],
      branches: [branch],
      ahead: 0,
      behind: 0,
      upstream: null,
      inspectedAt: 1,
      branchesLimited: false,
    };
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <GitLocalBranchActions
          projectId="p"
          copyId="copy"
          snapshot={snapshot}
          branch={branch}
          readOnly={false}
        />
      </QueryClientProvider>,
    );
    const menuLabel = `Actions de la branche ${branch.name}`;
    const menuTrigger = screen.getByRole('button', { name: menuLabel });
    await page.getByRole('button', { name: menuLabel }).click();
    await page
      .getByRole('menuitem', { name: 'Fusionner dans la branche actuelle…' })
      .click();
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    expect(dialog).toHaveTextContent(`${branch.name} → main`);
    expect(dialog.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    // Reproduce delayed WebKit exit events while retaining the real animation.
    dialog.style.animationDuration = '1200ms';
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await waitForDialogClose(dialog, view.container);
    await expect.poll(() => document.activeElement).toBe(menuTrigger);
    await page.getByRole('button', { name: menuLabel }).click();
    await page.getByRole('menuitem', { name: 'Changer de branche…' }).click();
    const switching = await screen.findByRole('dialog');
    expect(switching).toHaveTextContent(`main → ${branch.name}`);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await waitForDialogClose(switching, view.container);
    await expect.poll(() => document.activeElement).toBe(menuTrigger);
    await page.getByRole('button', { name: menuLabel }).click();
    await page
      .getByRole('menuitem', { name: 'Supprimer la branche locale…' })
      .click();
    const deletion = await screen.findByRole('dialog');
    expect(deletion).toHaveTextContent(branch.name);
    expect(deletion).toHaveTextContent('Aucun fichier ni branche distante');
    expect(deletion.scrollWidth).toBeLessThanOrEqual(deletion.clientWidth);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await waitForDialogClose(deletion, view.container);
    await expect.poll(() => document.activeElement).toBe(menuTrigger);
  },
);
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
      await screen.findByRole('tab', { name: 'Fichiers' });
      const refresh = screen.getByRole('button', {
        name: 'Actualiser le dépôt',
      });
      const scopeTabs =
        refresh.parentElement!.querySelector('[role="tablist"]')!;
      expect(scopeTabs).not.toBeNull();
      expect(refresh.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        scopeTabs.getBoundingClientRect().right - 1,
      );
      await page.getByRole('tab', { name: 'Branches', exact: true }).click();
      const branchMenu = await screen.findByRole('button', {
        name: 'Actions de la branche main',
      });
      const branchRow = branchMenu.closest('.border-b')!;
      expect(branchMenu.getBoundingClientRect().right).toBeLessThanOrEqual(
        width,
      );
      expect(branchMenu.getBoundingClientRect().right).toBeGreaterThanOrEqual(
        branchRow.getBoundingClientRect().right - 4,
      );
      expect(
        screen.queryByRole('button', { name: 'Changer de branche…' }),
      ).toBeNull();
      expect(screen.queryByText(/Branches locales de cette copie/)).toBeNull();
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-branches-${width}.png`,
      });
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
      await page.getByRole('tab', { name: 'GitHub', exact: true }).click();
      expect(
        within(screen.getByRole('tabpanel', { name: 'GitHub' }))
          .getAllByRole('tab')
          .map((element) => element.textContent),
      ).toEqual(['Fichiers', 'Branches', 'PR', 'Merges']);
      await page.getByRole('button', { name: /#12/ }).click();
      await screen.findByText('En cours');
      expect(fixture.scrollWidth).toBeLessThanOrEqual(width);
      await page.getByRole('tab', { name: 'Branches' }).click();
      const remoteMenuName =
        'Actions de la branche distante feature/publiee-sur-github';
      const remoteTrigger = await screen.findByRole('button', {
        name: remoteMenuName,
      });
      expect(remoteTrigger.getBoundingClientRect().right).toBeLessThanOrEqual(
        width,
      );
      await page.getByRole('button', { name: remoteMenuName }).click();
      await page
        .getByRole('menuitem', { name: 'Récupérer cette branche en local…' })
        .click();
      const retrieveDialog = await screen.findByRole('dialog');
      expect(retrieveDialog).toHaveTextContent('feature/publiee-sur-github');
      expect(retrieveDialog).toHaveTextContent('Branche active conservée');
      expect(retrieveDialog.scrollWidth).toBeLessThanOrEqual(
        retrieveDialog.clientWidth,
      );
      // Exit animations can finish late on WebKit/loaded runners.
      retrieveDialog.style.animationDuration = '1200ms';
      await page.getByRole('button', { name: 'Annuler', exact: true }).click();
      await waitForDialogClose(retrieveDialog, view.container);
      await expect.poll(() => document.activeElement).toBe(remoteTrigger);
      await page.getByRole('button', { name: remoteMenuName }).click();
      await page
        .getByRole('menuitem', { name: 'Créer une pull request' })
        .click();
      const prDialog = await screen.findByRole('dialog');
      await screen.findByRole('option', { name: 'main' });
      expect(prDialog).toHaveTextContent('feature/publiee-sur-github');
      expect(prDialog).toHaveTextContent('Aucune copie locale');
      fireEvent.change(screen.getByLabelText('Branche cible'), {
        target: { value: 'main' },
      });
      expect(prDialog.scrollWidth).toBeLessThanOrEqual(prDialog.clientWidth);
      expect(
        screen.getByRole('button', { name: 'Créer une pull request' }),
      ).toBeEnabled();
      await page.getByRole('button', { name: 'Annuler', exact: true }).click();
      await waitForDialogClose(prDialog, view.container);
      await expect.poll(() => document.activeElement).toBe(remoteTrigger);
      await page
        .getByRole('tab', { name: 'Synchronisation', exact: true })
        .click();
      expect(
        await screen.findByRole('region', { name: 'Synchronisation' }),
      ).toBeVisible();
      expect(
        screen.getAllByRole('button', { name: 'Actualiser le dépôt' }),
      ).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Commit…' })).toBeNull();
      expect(fixture.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-sync-${width}.png`,
      });
      await page.getByRole('tab', { name: 'GitHub', exact: true }).click();
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-panel-${width}.png`,
      });
      await page.getByRole('tab', { name: 'Branches' }).click();
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
