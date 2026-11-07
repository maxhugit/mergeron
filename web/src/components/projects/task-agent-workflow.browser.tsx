import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { ProjectTaskManager } from './project-task-manager';
import type { ProjectTaskBoard, ProjectTaskSummary } from '@/lib/projects-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

const { api, navigate } = vi.hoisted(() => ({
  api: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('@/lib/projects-api', async (original) => ({
  ...(await original<typeof import('@/lib/projects-api')>()),
  projectsApi: api,
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));
vi.mock('@/components/chat/voice-dictation-button', () => ({
  VoiceDictationButton: () => null,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function setup(agentState: ProjectTaskSummary['agentState'] = 'ready') {
  await i18nReady;
  await i18n.changeLanguage('fr');
  api.mockReset();
  navigate.mockReset();
  const main = {
    assigneeId: null,
    id: 'main',
    resourceId: 'r',
    statusId: 'todo',
    title: 'Dossier principal',
    description: '',
    priority: 'normal',
    parentTaskId: null,
    subtaskStatus: 'todo',
    workspacePath: '/work',
    executionMode: 'manual',
    agentState: 'manual',
    estimateMinutes: 0,
    progress: 0,
    startAt: null,
    dueAt: null,
    validationCriteria: '',
    labels: [],
    linkedThreadId: null,
    linkedSimpleChatId: null,
    linkedFilePath: null,
    position: 0,
    createdAt: 1,
    updatedAt: 41,
  } as ProjectTaskSummary;
  const sub = {
    ...main,
    id: 'sub',
    title: 'Rédiger la synthèse',
    parentTaskId: 'main',
    executionMode: 'agent',
    agentState,
    linkedThreadId: agentState === 'review' ? 'existing' : null,
    updatedAt: 42,
  } as ProjectTaskSummary;
  const board = {
    project: { id: 'p', name: 'Projet de test', workspacePath: '/work' },
    resource: {
      id: 'r',
      projectId: 'p',
      type: 'task_board',
      name: 'Tâches',
      config: {},
    },
    workspaces: [],
    statuses: [
      {
        id: 'todo',
        resourceId: 'r',
        name: 'À faire',
        kind: 'unassigned',
        system: true,
        position: 0,
      },
    ],
    tasks: [main, sub],
    dependencies: [],
    activity: [],
  } as unknown as ProjectTaskBoard;
  api.mockImplementation((path?: string, init?: RequestInit) => {
    if (init?.method === 'PATCH')
      return Promise.resolve({
        task: { ...sub, ...JSON.parse(String(init.body)), updatedAt: 43 },
      });
    if (path?.endsWith('/agent'))
      return Promise.resolve({
        threadId: 'existing',
        state: 'needs_attention',
      });
    if (path === '/people') return Promise.resolve({ people: [] });
    if (path?.endsWith('/participants'))
      return Promise.resolve({ participants: [] });
    if (!path)
      return Promise.resolve({
        projects: [{ id: 'p', resources: [], workspaces: [] }],
      });
    return Promise.resolve(board);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectTaskManager
        projectId="p"
        resourceId="r"
        initialTaskId="sub"
        modalOnly
      />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Enregistrer' });
  return { client, board };
}

test.each([390, 1280])(
  'launches through the durable server action with the saved revision at %ipx',
  async (width) => {
    await page.viewport(width, 950);
    const warning = vi.spyOn(window, 'alert').mockImplementation(() => {});
    await setup();
    await page.screenshot({
      path: `../../../.vitest-screenshots/task-agent-editor-${width}.png`,
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Exécuter avec un agent' }),
    );
    await expect.poll(() => navigate.mock.calls.length).toBe(1);
    const patch = api.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(patch![1].body).expectedUpdatedAt).toBe(42);
    const launch = api.mock.calls.find(([path]) =>
      String(path).endsWith('/tasks/sub/agent'),
    );
    expect(JSON.parse(launch![1].body)).toMatchObject({
      expectedUpdatedAt: 43,
      requestId: expect.any(String),
    });
    expect(warning).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({
      to: '/t/$threadId',
      params: { threadId: 'existing' },
    });
    expect(
      api.mock.calls.some(([path]) => String(path).includes('/api/threads')),
    ).toBe(false);
  },
);

test('keeps the draft revision after a concurrent board refresh and validates without any agent deletion', async () => {
  await page.viewport(1280, 950);
  const { client, board } = await setup('review');
  client.setQueryData(['project-resource', 'p', 'r'], {
    ...board,
    tasks: board.tasks.map((task) => ({ ...task, updatedAt: 99 })),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Valider et terminer' }));
  await expect
    .poll(
      () =>
        api.mock.calls.filter(([, init]) => init?.method === 'PATCH').length,
    )
    .toBe(1);
  const body = JSON.parse(
    api.mock.calls.find(([, init]) => init?.method === 'PATCH')![1].body,
  );
  expect(body).toMatchObject({
    expectedUpdatedAt: 42,
    agentState: 'validated',
    subtaskStatus: 'done',
  });
  expect(api.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(
    false,
  );
});

test('keeps a conflicting validation open and tells the user to refresh instead of closing or relaunching', async () => {
  await setup('review');
  const base = api.getMockImplementation()!;
  api.mockImplementation((path, init) =>
    init?.method === 'PATCH'
      ? Promise.reject(new Error('Task changed. Reload before saving.'))
      : base(path, init),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Valider et terminer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Task changed');
  expect(
    screen.getByRole('button', { name: 'Valider et terminer' }),
  ).toBeInTheDocument();
  expect(navigate).not.toHaveBeenCalled();
});
