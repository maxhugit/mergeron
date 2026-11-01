import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectSettingsPanel } from './project-settings-dialog';
import type { ProjectSummary } from '@/lib/projects-api';

const queries = vi.hoisted(() => ({
  models: vi.fn(),
  mcps: vi.fn(),
  apps: vi.fn(),
}));
vi.mock('@/lib/platform-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform-session')>()),
  usePlatformSession: () => ({ isAdministrator: true }),
}));
vi.mock(
  '@/generated/api/@tanstack/react-query.gen',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/generated/api/@tanstack/react-query.gen')
    >()),
    modelsListModelsOptions: () => ({
      queryKey: ['fixture-models'],
      queryFn: queries.models,
    }),
  }),
);
vi.mock('@/lib/project-integrations-queries', () => ({
  projectMcpServersQueryOptions: () => ({
    queryKey: ['fixture-mcps'],
    queryFn: queries.mcps,
  }),
  projectAppsQueryOptions: () => ({
    queryKey: ['fixture-apps'],
    queryFn: queries.apps,
  }),
  availableProjectApps: () => [],
}));
vi.mock('./project-knowledge-panel', () => ({
  ProjectKnowledgePanel: () => null,
}));
vi.mock('@/components/chat/sidebar/external-workspace-resources', () => ({
  ExternalWorkspaceResources: () => null,
}));

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.models.mockReset().mockResolvedValue({ data: [] });
  queries.mcps.mockReset().mockResolvedValue({ data: [] });
  queries.apps.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  client.clear();
});

it.each(['workspaces', 'browser'] as const)(
  'does not query agent catalogs in %s settings, but loads them when agents are selected',
  async (section) => {
    const project = {
      id: 'p',
      name: 'Project',
      workspaces: [],
    } as unknown as ProjectSummary;
    const view = (selected: 'workspaces' | 'browser' | 'agents') => (
      <QueryClientProvider client={client}>
        <ProjectSettingsPanel
          project={project}
          section={selected}
          canManageParticipants={true}
        />
      </QueryClientProvider>
    );
    const rendered = render(view(section));
    expect(queries.models).not.toHaveBeenCalled();
    expect(queries.mcps).not.toHaveBeenCalled();
    expect(queries.apps).not.toHaveBeenCalled();
    rendered.rerender(view('agents'));
    await waitFor(() => expect(queries.models).toHaveBeenCalledTimes(1));
    expect(queries.mcps).toHaveBeenCalledTimes(1);
    expect(queries.apps).toHaveBeenCalledTimes(1);
  },
);
