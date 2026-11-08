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
vi.mock('@/lib/platform-session', async (original) => ({
  ...(await original<typeof import('@/lib/platform-session')>()),
  usePlatformSession: () => ({ isAdministrator: true }),
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

async function setup(
  agentState: ProjectTaskSummary['agentState'] = 'ready',
  failLaunch = false,
  initialTaskId: string | null = 'sub',
  withDeliverables = false,
  agentThreads: Array<{
    threadId: string;
    title: string;
    archived?: boolean;
    taskId?: string | null;
    taskParentTaskId?: string | null;
  }> = [],
  initialCreateParentId?: string,
) {
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
  let requested = false;
  api.mockImplementation((path?: string, init?: RequestInit) => {
    if (path?.endsWith('/deliverables'))
      return Promise.resolve({
        deliverables: [
          {
            id: 'output',
            title: 'Présentation',
            version: 7,
            primaryTaskId: null,
            lifecycleStatus: 'draft',
          },
        ],
      });
    if (init?.method === 'PATCH')
      return Promise.resolve({
        task: {
          ...(String(path).endsWith('/main') ? main : sub),
          ...JSON.parse(String(init.body)),
          updatedAt: 43,
        },
      });
    if (path?.endsWith('/agent')) {
      requested = true;
      return Promise.resolve({
        threadId: 'existing',
        state: failLaunch ? 'needs_attention' : 'submitted',
      });
    }
    if (path?.endsWith('/agent-launch'))
      return Promise.resolve({
        launch:
          requested && failLaunch
            ? {
                id: 'receipt',
                resourceId: 'r',
                phase: 'dispatching',
                state: 'needs_attention',
                threadId: 'existing',
                revision: 10,
                targetRevision: 43,
                busy: false,
              }
            : null,
        candidates: [],
      });
    if (path === '/people') return Promise.resolve({ people: [] });
    if (path?.endsWith('/participants'))
      return Promise.resolve({ participants: [] });
    if (!path)
      return Promise.resolve({
        projects: [
          {
            id: 'p',
            agentThreads,
            resources: withDeliverables
              ? [{ id: 'deliverables', type: 'deliverable_board' }]
              : [],
            workspaces: [],
          },
        ],
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
        initialTaskId={initialTaskId ?? undefined}
        initialCreateParentId={initialCreateParentId}
        modalOnly={initialTaskId !== null || initialCreateParentId !== undefined}
      />
    </QueryClientProvider>,
  );
  if (initialTaskId || initialCreateParentId !== undefined) await screen.findByRole('button', { name: 'Enregistrer' });
  else await screen.findByRole('button', { name: 'Dossier principal' });
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
    expect(warning).not.toHaveBeenCalled();
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

test.each([390, 1280])(
  'shows recovery immediately after an uncertain send in the actual task editor at %ipx',
  async (width) => {
    await page.viewport(width, 950);
    await setup('ready', true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Exécuter avec un agent' }),
    );
    const recovery = await screen.findByRole('region', {
      name: 'Reprise du lancement de l’agent',
    });
    const open = screen.getByRole('button', { name: 'Ouvrir l’agent' });
    expect(recovery.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(open.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      window.innerHeight,
    );
    expect(navigate).not.toHaveBeenCalled();
    await page.screenshot({
      path: `../../../.vitest-screenshots/task-editor-recovery-${width}.png`,
    });
  },
);

test.each([390, 1280])(
  'selects an exclusive task reference and hides deliverables without a manager at %ipx',
  async (width) => {
    await page.viewport(width, 950);
    await setup('ready', false, 'main', false);
    let selector = screen.getByRole('combobox', {
      name: 'Type de référence',
    }) as HTMLSelectElement;
    expect(Array.from(selector.options).map((option) => option.value)).toEqual([
      'folder',
    ]);
    cleanup();
    await setup('ready', false, 'main', true);
    selector = screen.getByRole('combobox', {
      name: 'Type de référence',
    }) as HTMLSelectElement;
    await expect
      .poll(() => Array.from(selector.options).map((option) => option.value))
      .toEqual(['folder', 'deliverable']);
    fireEvent.change(selector, { target: { value: 'deliverable' } });
    const choice = screen
      .getAllByRole('combobox')
      .find((element) =>
        Array.from((element as HTMLSelectElement).options).some(
          (option) => option.value === 'output',
        ),
      ) as HTMLSelectElement;
    expect(choice).toBeDefined();
    fireEvent.change(choice, { target: { value: 'output' } });
    selector.focus();
    selector.scrollIntoView({ block: 'center' });
    await expect
      .poll(
        () =>
          selector.getBoundingClientRect().top >= 0 &&
          selector.getBoundingClientRect().bottom <= window.innerHeight,
      )
      .toBe(true);
    await page.screenshot({
      path: `../../../.vitest-screenshots/task-work-reference-${width}.png`,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await expect
      .poll(
        () =>
          api.mock.calls.filter(([, init]) => init?.method === 'PATCH').length,
      )
      .toBe(1);
    const patch = api.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    const body = JSON.parse(String(patch[1].body));
    expect(body.workReference).toEqual({
      type: 'deliverable',
      deliverableId: 'output',
      expectedVersion: 7,
    });
    expect(body.workspacePath).toBeUndefined();
  },
);

test.each([390, 1280])(
  'assigns and removes an existing agent without starting a turn at %ipx',
  async (width) => {
    await page.viewport(width, 950);
    await setup('ready', false, 'sub', false, [
      { threadId: 'available', title: 'Agent disponible' },
    ]);
    const selector = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Choisir un agent existant',
    });
    await expect
      .poll(() =>
        Array.from(selector.options).some(
          (option) => option.value === 'available',
        ),
      )
      .toBe(true);
    fireEvent.change(selector, { target: { value: 'available' } });
    expect(
      screen.queryByRole('button', { name: 'Exécuter avec un agent' }),
    ).toBeNull();
    selector.focus();
    selector.scrollIntoView({ block: 'center' });
    await page.screenshot({
      path: `../../../.vitest-screenshots/task-agent-assignment-${width}.png`,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await expect
      .poll(() => api.mock.calls.some(([, init]) => init?.method === 'PATCH'))
      .toBe(true);
    expect(
      JSON.parse(
        String(
          api.mock.calls.find(([, init]) => init?.method === 'PATCH')![1].body,
        ),
      ),
    ).toMatchObject({ linkedThreadId: 'available', executionMode: 'agent' });
    expect(
      api.mock.calls.some(([path]) => String(path).endsWith('/agent')),
    ).toBe(false);
    cleanup();
    await setup('review', false, 'sub', false, [
      { threadId: 'existing', title: 'Agent existant' },
    ]);
    fireEvent.click(
      screen.getByRole('button', { name: 'Retirer l’affectation' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await expect
      .poll(() => api.mock.calls.some(([, init]) => init?.method === 'PATCH'))
      .toBe(true);
    expect(
      JSON.parse(
        String(
          api.mock.calls.find(([, init]) => init?.method === 'PATCH')![1].body,
        ),
      ).linkedThreadId,
    ).toBeNull();
    expect(api.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(
      false,
    );
  },
);

test('submits a plan atomically and reuses the exact request after a lost response', async () => {
  await page.viewport(1280, 950);
  await setup('ready', false, null);
  const original = api.getMockImplementation()!;
  let calls = 0;
  api.mockImplementation((path?: string, init?: RequestInit) => {
    if (path?.endsWith('/ai-plan'))
      return Promise.resolve({
        tasks: [
          {
            title: 'Atomic task',
            description: 'Draft',
            priority: 'normal',
            estimateHours: 1,
            validationCriteria: 'Done',
            labels: [],
            dependsOnTitles: [],
            parentTitle: '',
            reason: 'Example',
          },
        ],
      });
    if (path?.endsWith('/task-batches'))
      return ++calls === 1
        ? Promise.reject(new Error('Response lost'))
        : Promise.resolve({ tasks: [], replayed: true });
    return original(path, init);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Planifier avec l’IA' }));
  fireEvent.change(
    screen.getByPlaceholderText(
      'Décrivez l’objectif, les contraintes et le résultat attendu…',
    ),
    { target: { value: 'Create an atomic plan' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Générer le plan' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Créer les 1 tâches' }),
  );
  await screen.findByText('Response lost');
  fireEvent.click(screen.getByRole('button', { name: 'Créer les 1 tâches' }));
  await expect.poll(() => calls).toBe(2);
  const requests = api.mock.calls.filter(([path]) =>
    String(path).endsWith('/task-batches'),
  );
  expect(requests[1][1].body).toBe(requests[0][1].body);
  expect(JSON.parse(String(requests[0][1].body)).operations).toHaveLength(1);
  expect(
    api.mock.calls.some(
      ([path, init]) =>
        String(path).endsWith('/tasks') && init?.method === 'POST',
    ),
  ).toBe(false);
});

test('reuses a same-parent agent and excludes another main task without launching it', async () => {
  await page.viewport(1280, 950);
  const { client, board } = await setup('ready', false, 'sub', false, [
    {
      threadId: 'same',
      title: 'Cadrage',
      taskId: 'sibling',
      taskParentTaskId: 'main',
    },
    {
      threadId: 'other',
      title: 'Other main',
      taskId: 'elsewhere',
      taskParentTaskId: 'another-main',
    },
  ]);
  board.tasks.push({
    ...board.tasks[1],
    id: 'sibling',
    linkedThreadId: 'same',
  });
  client.setQueryData(['project-resource', 'p', 'r'], { ...board });
  const selector = screen.getByRole<HTMLSelectElement>('combobox', {
    name: 'Choisir un agent existant',
  });
  await expect
    .poll(() =>
      Array.from(selector.options).some((option) => option.value === 'same'),
    )
    .toBe(true);
  expect(
    Array.from(selector.options).some((option) => option.value === 'other'),
  ).toBe(false);
  fireEvent.change(selector, { target: { value: 'same' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await expect
    .poll(() => api.mock.calls.some(([, init]) => init?.method === 'PATCH'))
    .toBe(true);
  expect(api.mock.calls.some(([path]) => String(path).endsWith('/agent'))).toBe(
    false,
  );
});

test.each(['', 'main'])('opens the existing task creation form from the sidebar (%s)', async (parentId) => {
  await page.viewport(390,950);
  await setup('ready',false,null,false,[],parentId);
  expect(await screen.findByRole('dialog', {name: parentId ? 'Nouvelle sous-tâche' : 'Nouvelle tâche'})).toBeTruthy();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(api.mock.calls.some(([,init]) => init?.method === 'POST')).toBe(false);
});
