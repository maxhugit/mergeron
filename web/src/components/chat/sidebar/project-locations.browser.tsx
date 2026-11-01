import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { ProjectSettingsPanel } from '@/components/projects/project-settings-dialog';
import type { ProjectSummary } from '@/lib/projects-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { locationInventoryFixture } from '@/test/project-locations-fixture';
import type { GitInventory } from '@/lib/workspace-git-api';
import { DragDropProvider } from '@dnd-kit/react';
import { WorkspaceOverview } from './workspace-overview';
import { useAgentViewCacheStore } from '@/stores/agent-view-cache-store';
vi.mock('./workspace-transfers', () => ({ WorkspaceTransfers: () => null }));
vi.mock('@/lib/platform-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform-session')>()),
  usePlatformSession: () => ({ isAdministrator: true }),
}));
const modelQuery = vi.hoisted(() => vi.fn().mockResolvedValue({ data: [] }));
vi.mock(
  '@/generated/api/@tanstack/react-query.gen',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/generated/api/@tanstack/react-query.gen')
    >()),
    modelsListModelsOptions: () => ({
      queryKey: ['fixture-models'],
      queryFn: modelQuery,
    }),
  }),
);
vi.mock('@/lib/projects-api', () => ({
  projectsQueryKey: ['projects'],
  projectsApi: vi.fn().mockImplementation(async () =>
    locationInventoryFixture({
      resources: [
        {
          id: 'git',
          projectId: 'p',
          localWorkspaceId: null,
          capabilities: { read: true, write: false, execute: false },
          lastCheckedAt: null,
          lastError: null,
          hasSecret: false,
          localPath: null,
          name: 'Dépôt Git du projet',
          type: 'git',
          address: 'https://example.test/repo.git',
          enabled: true,
          connectionState: 'connected',
          accessMode: 'read_only',
          rootPath: '/',
        },
      ],
      copies: [],
    } as GitInventory),
  ),
}));
afterEach(cleanup);
test.each([390, 1180])(
  'keeps project headings free of workspace counts at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    useAgentViewCacheStore.getState().toggleProject('p');
    const openProject = vi.fn();
    try {
      render(
        <aside className="w-64 bg-background p-3 text-foreground">
          <DragDropProvider>
            <WorkspaceOverview
              projectsHeader={<h2>Projets</h2>}
              workspaceGroups={[
                {
                  projectId: 'p',
                  cwd: '/workspaces/p',
                  name: 'Projet de conception',
                  workspaces: [0, 1, 2].map((index) => ({
                    id: `workspace-${index}`,
                    projectId: 'p',
                    name: `Workspace ${index}`,
                    path: `/workspaces/p/${index}`,
                    primary: index === 0,
                    createdAt: 1,
                    updatedAt: 1,
                  })),
                  threads: [],
                  simpleChats: [],
                },
              ]}
              collapsedGroups={new Set()}
              isLoading={false}
              onToggleCollapse={vi.fn()}
              onOpenProject={openProject}
              onOpenArchivedDetail={vi.fn()}
              onOpenWorkspaceDetail={vi.fn()}
              onCreateAgentInWorkspace={vi.fn()}
              onCreateSimpleChatInWorkspace={vi.fn()}
              onCreateTaskBoard={vi.fn()}
              onOpenResource={vi.fn()}
              resourceActionPending={false}
              onRenameResource={vi.fn()}
              onDeleteResource={vi.fn()}
              renderThreadRow={() => null}
              renderSimpleChatRow={() => null}
              movingThread={false}
            />
          </DragDropProvider>
        </aside>,
      );
      expect(screen.queryByText(/emplacements locaux/)).not.toBeInTheDocument();
      const heading = screen.getByRole('button', {
        name: /Projet de conception/,
      });
      expect(heading).toBeVisible();
      expect(heading.textContent).toBe('Projet de conception');
      expect(screen.getByRole('img')).toBeVisible();
      expect(
        screen.getByRole('button', { name: 'Actions du projet' }),
      ).toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../../.vitest-screenshots/sidebar-project-no-count-${width}.png`,
      });
      fireEvent.click(heading);
      expect(openProject).toHaveBeenCalledWith('p');
    } finally {
      useAgentViewCacheStore.getState().clear();
    }
  },
);
test.each([390, 1001])(
  'distinguishes managed local locations and external connections at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const project = {
      id: 'p',
      name: 'Projet',
      workspaces: [
        { id: 'main', name: 'Principal', path: '/workspaces/p', primary: true },
        {
          id: 'other',
          name: 'Code local',
          path: '/source/project',
          primary: false,
        },
      ],
      agentThreads: [],
    } as unknown as ProjectSummary;
    modelQuery.mockClear();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectSettingsPanel
          project={project}
          section="workspaces"
          canManageParticipants={true}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole('heading', {
        name: 'Gérer les emplacements et connexions',
      }),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Emplacements locaux' }),
    ).toBeVisible();
    expect(screen.getByText('Espace local géré')).toBeVisible();
    expect(await screen.findByText('Dépôt Git du projet')).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Connexions externes' }),
    ).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const engine = navigator.userAgent.includes('Chrome')
      ? 'chromium'
      : 'webkit';
    await page.screenshot({
      path: `../../../../.vitest-screenshots/project-locations-current-${engine}-${width}.png`,
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Ajouter un emplacement ou une connexion',
      }),
    );
    expect(
      screen.getByRole('dialog', {
        name: 'Ajouter un emplacement ou une connexion',
      }),
    ).toBeVisible();
    expect(modelQuery).not.toHaveBeenCalled();
    expect(project.workspaces[0].path).toBe('/workspaces/p');
  },
);
