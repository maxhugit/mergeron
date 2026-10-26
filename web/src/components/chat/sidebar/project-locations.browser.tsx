import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { ManageWorkspacesDialog } from './manage-workspaces-dialog';
import type { ProjectSummary } from '@/lib/projects-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { locationInventoryFixture } from '@/test/project-locations-fixture';
import type { GitInventory } from '@/lib/workspace-git-api';
vi.mock('./workspace-transfers', () => ({ WorkspaceTransfers: () => null }));
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
    const add = vi.fn(),
      detach = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ManageWorkspacesDialog
          project={project}
          pending={false}
          onClose={() => {}}
          onAdd={add}
          onDetach={detach}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole('dialog', {
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
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Ajouter un emplacement ou une connexion',
      }),
    );
    expect(add).toHaveBeenCalledWith(project);
    expect(detach).not.toHaveBeenCalled();
    expect(project.workspaces[0].path).toBe('/workspaces/p');
  },
);
