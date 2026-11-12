import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { ProjectLocationsPanel } from './project-locations-panel';
import { ExternalWorkspaceResources } from '@/components/chat/sidebar/external-workspace-resources';
import type { ProjectLocationInventory } from '@/lib/project-locations-api';
import type { ProjectSummary } from '@/lib/projects-api';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({
  projectsApi: api,
  projectsQueryKey: ['projects'],
}));
const project = {
  id: 'p',
  name: 'Project',
  workspacePath: '/workspace/p',
  createdAt: 1,
  updatedAt: 1,
  resources: [],
  workspaces: [],
  agentThreads: [
    {
      threadId: 'developer',
      title: 'Développeur',
      workspacePath: '/workspace/copy',
    },
  ],
} as unknown as ProjectSummary;
const inventory: ProjectLocationInventory = {
  modelVersion: 1,
  connections: [
    {
      id: 'git',
      projectId: 'p',
      name: 'Git Test',
      protocol: 'git',
      address: 'https://example.test/repo.git',
      enabled: true,
      agentEnabled: true,
      connectionState: 'connected',
      lastCheckedAt: null,
      hasSecret: true,
      fileScope: {
        rootPath: '/',
        accessMode: 'read_write',
        capabilities: { read: true, write: true, execute: false },
      },
    },
  ],
  locations: [
    {
      id: 'local:copy',
      projectId: 'p',
      name: 'Copie développeur',
      kind: 'attached_local',
      path: '/workspace/copy',
      localWorkspaceId: 'copy',
      connectionId: null,
      accessMode: 'read_write',
      capabilities: { read: true, write: true, execute: false },
      workingCopyId: 'copy',
    },
  ],
  copies: [
    {
      id: 'copy',
      projectId: 'p',
      name: 'Copie développeur',
      sourceResourceId: 'git',
      localWorkspaceId: 'copy',
      branch: 'main',
      revision: 'abcdef123456789',
      state: 'ready',
      lastError: null,
      localPath: '/workspace/copy',
      sourceName: 'Git Test',
      sourceType: 'git',
      accessMode: 'read_write',
      sourceEnabled: true,
      createdAt: 1,
      updatedAt: 1,
      locationId: 'local:copy',
      sourceConnectionId: 'git',
    },
  ],
};
let client: QueryClient;
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  api.mockReset().mockImplementation(async () => inventory);
});
afterEach(() => {
  cleanup();
  client.clear();
});
function mount(view: React.ReactNode) {
  return render(
    <QueryClientProvider client={client}>{view}</QueryClientProvider>,
  );
}
it('lists and manages Git copies with their paths, revisions, rights and associated conversations in Locations', async () => {
  mount(
    <ProjectLocationsPanel
      project={project}
      pending={false}
      onAddLocal={() => {}}
      onDetachLocal={() => {}}
    />,
  );
  expect(await screen.findByText('Copie développeur')).toBeVisible();
  expect(screen.getByText(/main · abcdef123456/)).toBeVisible();
  expect(screen.getByText('Développeur')).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Supprimer cette copie…' }),
  ).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Créer une copie Git' }),
  ).toBeEnabled();
});
it('keeps connection-only Git records visible without duplicating copies or their actions', async () => {
  mount(
    <ExternalWorkspaceResources
      project={project}
      pending={false}
      allowCreate={false}
    />,
  );
  expect(await screen.findByText('Git Test')).toBeVisible();
  expect(screen.queryByText('Copie développeur')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Copie de travail' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Supprimer cette copie…' }),
  ).toBeNull();
});
it('creates a working copy from Locations using an existing Git connection and a selected branch', async () => {
  mount(
    <ProjectLocationsPanel
      project={project}
      pending={false}
      onAddLocal={() => {}}
      onDetachLocal={() => {}}
    />,
  );
  await screen.findByText('Copie développeur');
  fireEvent.click(screen.getByRole('button', { name: 'Créer une copie Git' }));
  fireEvent.change(screen.getByLabelText('Nom de l’emplacement'), {
    target: { value: 'Revue' },
  });
  fireEvent.change(screen.getByLabelText(/Branche/), {
    target: { value: 'review' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^Créer la copie$/ }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/p/connections/git/copies',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Revue', branch: 'review' }),
      }),
    ),
  );
  expect(screen.getByText('Copie développeur')).toBeVisible();
});
