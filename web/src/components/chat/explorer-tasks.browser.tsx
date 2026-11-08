import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { ExplorerTasks } from './explorer-tasks';
import type { ProjectSummary, ProjectTaskBoard } from '@/lib/projects-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const state = vi.hoisted(() => ({
  personId: 'alice',
  values: {} as Record<string, Record<string, boolean | string>>,
  patches: [] as unknown[],
}));
vi.mock('@/lib/platform-session', async (original) => ({
  ...(await original<typeof import('@/lib/platform-session')>()),
  usePlatformSession: () => ({
    isAdministrator: true,
    data: { personId: state.personId },
  }),
  readAuthResource: async (path: string) => ({
    personId: state.personId,
    values: state.values[`${state.personId}:${path}`] ?? {},
  }),
  updateAuthResource: async (
    path: string,
    change: { key: string; value: boolean | string; personId: string },
  ) => {
    const key = `${change.personId}:${path}`;
    state.values[key] = { ...state.values[key], [change.key]: change.value };
    return { personId: change.personId, values: state.values[key] };
  },
}));
vi.mock('@/lib/projects-api', async (original) => ({
  ...(await original<typeof import('@/lib/projects-api')>()),
  projectsApi: async (_path: string, options?: RequestInit) => {
    if (options?.method === 'PATCH') {
      state.patches.push(JSON.parse(String(options.body)));
      return {};
    }
    return board;
  },
}));
const board = {
  resource: {
    id: 'tasks',
    type: 'task_board',
    name: 'Tâches',
    config: {
      taskBoardSettings: {
        labels: [{ id: 'quality', name: 'Qualité', color: 'blue' }],
      },
    },
  },
  tasks: [
    {
      id: 'main',
      title: 'Préparer le site du club',
      parentTaskId: null,
      resourceId: 'tasks',
      labels: [],
      updatedAt: 1,
    },
    {
      id: 'one',
      title: 'Définir les publics et leurs usages',
      parentTaskId: 'main',
      resourceId: 'tasks',
      labels: ['quality'],
      linkedThreadId: 'agent',
      progress: 40,
      subtaskStatus: 'in_progress',
      updatedAt: 1,
    },
    {
      id: 'two',
      title: 'Valider les parcours',
      parentTaskId: 'main',
      resourceId: 'tasks',
      labels: [],
      linkedThreadId: null,
      progress: 0,
      subtaskStatus: 'todo',
      updatedAt: 1,
    },
    {
      id: 'other',
      title: 'Un autre chantier',
      parentTaskId: null,
      resourceId: 'tasks',
      labels: [],
      updatedAt: 1,
    },
    {
      id: 'three',
      title: 'Une sous-tâche incompatible',
      parentTaskId: 'other',
      resourceId: 'tasks',
      labels: [],
      linkedThreadId: null,
      progress: 0,
      subtaskStatus: 'todo',
      updatedAt: 1,
    },
  ],
  statuses: [],
  dependencies: [],
  activity: [],
  workspaces: [],
  project: { id: 'p', name: 'Club', workspacePath: '/p' },
} as unknown as ProjectTaskBoard;
const project = {
  id: 'p',
  resources: [board.resource],
  workspaces: [],
} as unknown as ProjectSummary;
function fixture(agent = 'agent') {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <div
        className="bg-background text-foreground"
        style={{ width: 'min(100%,400px)', height: '85vh' }}
      >
        <ExplorerTasks project={project} agentThreadId={agent} />
      </div>
    </QueryClientProvider>,
  );
}
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  state.personId = 'alice';
  state.values = {};
  state.patches = [];
  document.documentElement.classList.add('dark');
});
afterEach(cleanup);
for (const width of [390, 1280])
  test(`contextual assignment, disclosure persistence and label mode at ${width}px`, async () => {
    await page.viewport(width, 900);
    let view = fixture();
    const parent = await screen.findByRole('button', {
      name: /^Préparer le site du club/,
    });
    await expect.poll(() => parent.hasAttribute('disabled')).toBe(false);
    fireEvent.click(parent);
    await screen.findByText('Valider les parcours');
    await page
      .getByRole('button', { name: /Actions.*Valider les parcours/ })
      .click();
    const assign = await screen.findByRole('menuitem', {
      name: 'Affecter cet agent',
    });
    await page.getByRole('menuitem', { name: 'Affecter cet agent' }).click();
    expect(assign).toBeTruthy();
    await expect.poll(() => state.patches.length).toBe(1);
    expect(state.patches[0]).toMatchObject({
      linkedThreadId: 'agent',
      expectedUpdatedAt: 1,
    });
    fireEvent.change(screen.getByLabelText('Affichage des sous-tâches'), {
      target: { value: 'labels' },
    });
    await screen.findByText('Qualité');
    view.unmount();
    view = fixture();
    await screen.findByText('Qualité');
    expect(
      screen.getByRole('button', { name: /^Préparer le site du club/ }),
    ).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: /^Un autre chantier/ }));
    await screen.findByText('Une sous-tâche incompatible');
    await page
      .getByRole('button', { name: /Actions.*Une sous-tâche incompatible/ })
      .click();
    expect(
      await screen.findByRole('menuitem', { name: 'Affecter cet agent' }),
    ).toHaveAttribute('data-disabled');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
    await page.screenshot({
      path: `../../../.vitest-screenshots/agent-tasks-${width}.png`,
    });
    view.unmount();
    state.personId = 'bob';
    view = fixture();
    expect(
      await screen.findByRole('button', { name: /^Préparer le site du club/ }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Valider les parcours')).toBeNull();
    view.unmount();
    state.personId = 'alice';
    fixture('different-agent');
    expect(
      await screen.findByRole('button', { name: /^Préparer le site du club/ }),
    ).toHaveAttribute('aria-expanded', 'false');
  });
