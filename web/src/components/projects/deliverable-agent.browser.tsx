import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { ProjectDeliverablesManager } from './project-deliverables-manager';
import type { DeliverablesBoard } from '@/lib/deliverables-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects-api')>()),
  projectsApi: api,
  projectsQueryKey: ['projects'],
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/lib/platform-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform-session')>()),
  usePlatformSession: () => ({ isAdministrator: true }),
}));
afterEach(cleanup);

test.each([390, 1307])(
  'offers new and existing agents without horizontal overflow at %ipx',
  async (width) => {
    await page.viewport(width, 988);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const board = {
      resource: {
        id: 'r',
        projectId: 'p',
        type: 'deliverable_board',
        name: 'Livrables',
        config: {},
        createdAt: 1,
        updatedAt: 1,
      },
      deliverables: [
        {
          id: 'd',
          title: 'Dossier de conception',
          description: '',
          criteria: '',
          confidentiality: 'standard',
          authorizedGroupIds: [],
          assigneeId: null,
          dueAt: null,
          status: 'planned',
          lifecycleStatus: 'draft',
          currentSnapshotId: null,
          lastApprovedSnapshotId: null,
          validationRequired: false,
          validationStatus: 'not_required',
          finalizedAt: null,
          finalizedByPersonId: null,
          finalizedByName: null,
          primaryTaskId: null,
          taskIds: [],
          conversations: [],
          version: 1,
          validatedVersionId: null,
          activeFolder: null,
          directory: '/workspaces/p/livrables/d',
          createdAt: 1,
          updatedAt: 2,
          versions: [],
          documents: [],
          snapshots: [],
          lifecycleEvents: [],
          validations: [],
          validationEvents: [],
        },
      ],
      assignees: [],
      taskManagers: [],
      personGroups: [],
      tasks: [],
      conversations: [],
    } as DeliverablesBoard;
    api.mockImplementation((path?: string) =>
      Promise.resolve(
        path?.endsWith('/available-agents')
          ? { agents: [{ id: 'existing', title: 'Analyse des besoins' }] }
          : path === undefined
            ? { projects: [{ id: 'p', agentThreads: [], workspaces: [] }] }
            : board,
      ),
    );
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ProjectDeliverablesManager
          projectId="p"
          resourceId="r"
          initialDeliverableId="d"
        />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Confier à un agent' }),
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Agent de travail' }),
      { target: { value: 'existing' } },
    );
    await screen.findByRole('option', { name: 'Analyse des besoins' });
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Agent disponible du projet' }),
      { target: { value: 'existing' } },
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    expect(
      screen.getByRole('button', { name: 'Affecter cet agent' }),
    ).not.toBeDisabled();
    expect(
      api.mock.calls.some(
        ([path, input]) => String(path).endsWith('/agent') && input,
      ),
    ).toBe(false);
    if (width === 1307)
      await page.screenshot({
        path: '../../../.vitest-screenshots/deliverable-existing-agent.png',
      });
  },
);
