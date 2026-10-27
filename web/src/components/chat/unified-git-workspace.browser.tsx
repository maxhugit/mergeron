/** Real menus and workspace tabs, fixture data only: no user Git mutations. */
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { WorkspaceGitPanel } from './workspace-git-panel';
import { WorkspaceGitGraph } from './workspace-git-graph';
import { WorkspaceControls } from './workspace-controls';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { EMPTY_WORKSPACE, useWorkspaceStore } from '@/stores/workspace-store';
import { useFilesStore } from '@/stores/files-store';
import { locationInventoryFixture } from '@/test/project-locations-fixture';
import type { GitInventory } from '@/lib/workspace-git-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

// Each case changes the viewport between unmounted fixtures. Resolve it afresh
// rather than retaining the app hook's module singleton from the previous case.
vi.mock('@/hooks/use-breakpoint', () => ({
  useBreakpoint: () =>
    window.matchMedia('(min-width: 1024px)').matches ? 'desktop' : 'mobile',
}));

const state = vi.hoisted(() => ({
  copy: true,
  requests: [] as Array<{ url: string; method?: string }>,
}));
const activeFolder = vi.hoisted(() => vi.fn());
vi.mock('@/generated/api', () => ({ filesAddRoot: async () => ({}) }));
vi.mock('@/components/files/file-tree', () => ({
  FileTree: () => <div>Fichiers locaux consultés</div>,
}));
vi.mock('@/lib/projects-api', () => ({
  projectsQueryKey: ['projects'],
  projectsApi: async (url: string, options?: RequestInit) => {
    state.requests.push({ url, method: options?.method });
    if (url.endsWith('/locations'))
      return locationInventoryFixture({
        resources: [
          {
            id: 'git',
            projectId: 'p',
            type: 'git',
            name: 'Git Test',
            enabled: true,
            address: 'https://github.com/example/test.git',
            accessMode: 'read_write',
          },
        ],
        copies: state.copy
          ? [
              {
                id: 'copy',
                sourceResourceId: 'git',
                localWorkspaceId: 'local',
                ownerAgentIds: ['agent'],
                name: 'Git Test — copie',
                localPath: '/copy',
                sourceEnabled: true,
                state: 'ready',
                branch: 'main',
                accessMode: 'read_write',
              },
            ]
          : [],
      } as GitInventory);
    if (url.endsWith('/copies/copy'))
      return {
        fingerprint: 'index',
        branch: 'main',
        head: 'a'.repeat(40),
        changes: [],
        branches: [],
        ahead: 0,
        behind: 0,
      };
    if (url.endsWith('/graph'))
      return {
        limited: false,
        inspectedAt: 1,
        items: [
          {
            sha: 'a'.repeat(40),
            parents: ['b'.repeat(40), 'c'.repeat(40)],
            date: '2026-10-27T12:00:00Z',
            author: 'Maxime',
            subject: 'Fusion des améliorations du panneau Git',
            current: url.includes('/copies/'),
            refs: [{ name: 'main', remote: url.includes('/connections/') }],
          },
          {
            sha: 'b'.repeat(40),
            parents: ['c'.repeat(40)],
            date: '2026-10-27T11:00:00Z',
            author: 'Agent de travail',
            subject: 'Simplifier la navigation du dépôt',
            current: false,
            refs: [{ name: 'feature/interface', remote: false }],
          },
          {
            sha: 'c'.repeat(40),
            parents: [],
            date: '2026-10-26T10:00:00Z',
            author: 'Maxime',
            subject: 'Premier commit du projet',
            current: false,
            refs: [],
          },
        ],
      };
    if (url.includes('/files?'))
      return {
        ref: 'a'.repeat(40),
        path: '',
        items: [
          { name: 'coucou.js', path: 'coucou.js', type: 'file', size: 23 },
        ],
        content: null,
      };
    if (url.endsWith('/pull-requests'))
      return { supported: true, limited: false, items: [] };
    throw new Error(`Unexpected fixture request: ${url}`);
  },
}));
const context = 'thread:unified-git';
export function Fixture() {
  const [resourceId, setResourceId] = useState<string | null>('git');
  const [explorerOpen, setExplorerOpen] = useState(true);
  const desktop = useBreakpoint() === 'desktop';
  const workspace = useWorkspaceStore(
    (s) => s.contexts[context] ?? EMPTY_WORKSPACE,
  );
  return (
    <div className="dark flex h-[850px] min-w-0 bg-background text-foreground">
      <main
        className="flex min-w-0 flex-1 flex-col"
        style={{ display: !desktop && explorerOpen ? 'none' : undefined }}
      >
        <WorkspaceControls
          workspace={workspace}
          running={false}
          pending={0}
          onSelect={(id) => useWorkspaceStore.getState().select(context, id)}
          onClose={(tab) =>
            useWorkspaceStore.getState().remove(context, tab.id)
          }
          onExplorer={() => setExplorerOpen(true)}
          onNewTerminal={() => {}}
        />
        {workspace.activeId === 'conversation' ? (
          <p className="p-5">Conversation préservée</p>
        ) : (
          workspace.tabs.map(
            (tab) =>
              tab.kind === 'git-graph' &&
              tab.id === workspace.activeId && (
                <WorkspaceGitGraph key={tab.id} target={tab} active />
              ),
          )
        )}
      </main>
      {(desktop || explorerOpen) && (
        <aside
          className="flex min-h-0 shrink-0 flex-col border-l"
          style={{
            width: desktop ? 340 : '100%',
            maxWidth: desktop ? '48%' : undefined,
          }}
        >
          <WorkspaceGitPanel
            projectId="p"
            agentThreadId="agent"
            resourceId={resourceId}
            onSelect={setResourceId}
            cwd="/copy"
            activeWorkspacePending={false}
            onActiveWorkspaceChange={activeFolder}
            onFile={() => {}}
            onGitGraph={(target) => {
              useWorkspaceStore.getState().openGitGraph(context, target);
              if (!desktop) setExplorerOpen(false);
            }}
          >
            <span>Explorateur</span>
          </WorkspaceGitPanel>
        </aside>
      )}
    </div>
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
test.each([1100, 390])(
  'unified Git menu opens a graph workspace at %ipx without changing the active folder',
  async (width) => {
    await page.viewport(width, 930);
    await i18nReady;
    await i18n.changeLanguage('fr');
    state.copy = true;
    state.requests = [];
    activeFolder.mockClear();
    useFilesStore.setState({ rootDir: '/original' });
    useWorkspaceStore.setState({ contexts: {} });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Fixture />
      </QueryClientProvider>,
    );
    try {
      await screen.findByText('Copie locale disponible');
      expect(screen.queryByText('Git Test — copie')).toBeNull();
      await page
        .getByRole('button', { name: 'Actions Git · Git Test' })
        .click();
      expect(
        await screen.findByRole('menuitem', {
          name: 'Parcourir les fichiers locaux',
        }),
      ).toBeVisible();
      expect(
        screen.getByRole('menuitem', { name: /Préparer une copie/ }),
      ).toHaveAttribute('data-disabled');
      expect(
        screen.getByRole('menuitem', { name: /Supprimer cette copie/ }),
      ).toHaveAttribute('data-disabled');
      await page
        .getByRole('menuitem', {
          name: 'Afficher le graphe des branches et commits',
        })
        .click();
      await screen.findByText('Fusion des améliorations du panneau Git');
      expect(useWorkspaceStore.getState().contexts[context].tabs).toHaveLength(
        1,
      );
      expect(activeFolder).not.toHaveBeenCalled();
      expect(useFilesStore.getState().rootDir).toBe('/original');
      await page.screenshot({
        path: `../../../.vitest-screenshots/unified-git-graph-${width}.png`,
      });
      // Reopening reuses the same tab, and live remote history needs no fetch.
      if (width < 768)
        await page
          .getByRole('button', { name: 'Explorateur', exact: true })
          .click();
      await page
        .getByRole('button', { name: 'Actions Git · Git Test' })
        .click();
      await page
        .getByRole('menuitem', {
          name: 'Afficher le graphe des branches et commits',
        })
        .click();
      expect(useWorkspaceStore.getState().contexts[context].tabs).toHaveLength(
        1,
      );
      expect(state.requests.some((r) => r.method)).toBe(false);
      if (width < 768)
        await page
          .getByRole('button', { name: 'Explorateur', exact: true })
          .click();
      await page
        .getByRole('button', { name: 'Actions Git · Git Test' })
        .click();
      await page
        .getByRole('menuitem', { name: 'Parcourir les fichiers distants' })
        .click();
      await screen.findByRole('button', { name: 'coucou.js' });
      expect(activeFolder).not.toHaveBeenCalled();
      expect(useFilesStore.getState().rootDir).toBe('/original');
      await page
        .getByRole('button', { name: 'Actions Git · Git Test' })
        .click();
      await page
        .getByRole('menuitem', { name: 'Parcourir les fichiers locaux' })
        .click();
      await screen.findByText('Fichiers locaux consultés');
      expect(useFilesStore.getState().rootDir).toBe('/copy');
      expect(activeFolder).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      client.clear();
    }
  },
);

test('remote graph and files work without an agent copy', async () => {
  await page.viewport(1100, 930);
  await i18nReady;
  await i18n.changeLanguage('fr');
  state.copy = false;
  state.requests = [];
  useWorkspaceStore.setState({ contexts: {} });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Fixture />
    </QueryClientProvider>,
  );
  try {
    await screen.findAllByText('Aucune copie locale pour cet agent');
    await page.getByRole('button', { name: 'Actions Git · Git Test' }).click();
    expect(
      screen.getByRole('menuitem', { name: 'Parcourir les fichiers locaux' }),
    ).toHaveAttribute('data-disabled');
    await page
      .getByRole('menuitem', {
        name: 'Afficher le graphe des branches et commits',
      })
      .click();
    await screen.findByText('Fusion des améliorations du panneau Git');
    expect(
      state.requests.some((r) => r.url.endsWith('/connections/git/graph')),
    ).toBe(true);
    expect(
      state.requests.some((r) => r.url.includes('/copies/') || r.method),
    ).toBe(false);
  } finally {
    view.unmount();
    client.clear();
  }
});
