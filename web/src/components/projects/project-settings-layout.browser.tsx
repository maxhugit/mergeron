/** Full project UI, synthetic data and intercepted mutations; no live server/account. */
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { ProjectRoute } from '@/routes/project-route';
import { translationKey } from '@/locales/translation-key';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const fixture = vi.hoisted(() => ({
  administrator: true,
  writes: [] as { path: string; body: Record<string, unknown> }[],
}));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ projectId: 'p' }),
}));
vi.mock('@/lib/platform-session', async (original) => ({
  ...(await original<typeof import('@/lib/platform-session')>()),
  usePlatformSession: () => ({
    isAdministrator: fixture.administrator,
    data: { active: true, personId: 'person' },
  }),
}));
vi.mock('@/generated/api/@tanstack/react-query.gen', async (original) => ({
  ...(await original<
    typeof import('@/generated/api/@tanstack/react-query.gen')
  >()),
  modelsListModelsOptions: () => ({
    queryKey: ['fixture-models'],
    queryFn: async () => ({
      data: [
        {
          id: 'm',
          model: 'local-fixture',
          displayName: 'Fixture model',
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
        },
      ],
    }),
  }),
}));
vi.mock('@/lib/project-integrations-queries', () => ({
  projectMcpServersQueryOptions: () => ({
    queryKey: ['fixture-mcp'],
    queryFn: async () => ({
      data: [{ name: 'Fixture MCP', tools: { one: {} } }],
    }),
  }),
  projectAppsQueryOptions: () => ({
    queryKey: ['fixture-apps'],
    queryFn: async () => [
      { id: 'app', name: 'Fixture app', description: 'Test application' },
    ],
  }),
  availableProjectApps: (apps: unknown[]) => apps,
}));
vi.mock('@/lib/projects-api', () => ({
  projectsQueryKey: ['projects'],
  projectsApi: async (path = '', init?: RequestInit) => {
    if (path.endsWith('/test-environment/recipes')) return { agents: [] };
    const files = {
      'AGENTS.md': 'Instructions de contrôle.\n'.repeat(35),
      'CONNAISSANCES.md': 'Faits de contrôle.',
      'DECISIONS.md': 'Décisions de contrôle.',
    };
    const profile = {
      enabled: true,
      agentManaged: false,
      agentRuntimes: ['node'],
      runtime: 'node',
      directory: 'web',
      install: 'pnpm install',
      build: 'pnpm build',
      start: 'pnpm dev --host 0.0.0.0',
      port: 5173,
      path: '/',
      updateMode: 'hot',
      env: { TEST_KEY: '[stored]' },
      services: [],
      memoryMb: 1024,
      cpus: 2,
      lifetimeMinutes: 300,
    };
    if (init?.body)
      fixture.writes.push({ path, body: JSON.parse(String(init.body)) });
    if (path.endsWith('/knowledge'))
      return {
        files,
        revision: 'revision-1',
        path: '/workspaces/p/.mergeron-system/knowledge',
      };
    if (path.includes('/knowledge/proposals?'))
      return {
        proposals: [
          {
            id: 'proposal-1',
            title: 'Première proposition',
            file: 'DECISIONS.md',
            status: 'pending',
            version: 1,
            sourceType: 'agent',
            threadId: 'a',
            createdAt: 1,
            baseRevision: 'revision-1',
          },
          {
            id: 'proposal-2',
            title: 'Deuxième proposition',
            file: 'CONNAISSANCES.md',
            status: 'pending',
            version: 1,
            sourceType: 'agent',
            threadId: 'a',
            createdAt: 1,
            baseRevision: 'revision-1',
          },
        ],
        nextOffset: null,
      };
    if (path.includes('/knowledge/proposals/'))
      return {
        id: path.endsWith('1') ? 'proposal-1' : 'proposal-2',
        title: 'Proposition',
        file: 'DECISIONS.md',
        status: 'pending',
        version: 1,
        sourceType: 'agent',
        threadId: 'a',
        createdAt: 1,
        baseRevision: 'revision-1',
        baseFiles: files,
        proposedFiles: { ...files, 'DECISIONS.md': 'Texte proposé' },
      };
    if (path === '/people')
      return {
        people: [
          {
            id: 'person',
            name: 'Personne de contrôle',
            reference: 'P01',
            firstName: 'Personne',
            lastName: 'Contrôle',
            phone: '+33000000000',
            email: 'test@example.test',
            active: true,
            role: 'administrator',
            identityLinked: true,
          },
        ],
      };
    if (path.endsWith('/participants'))
      return {
        participants: [
          {
            personId: 'person',
            projectId: 'p',
            assignmentCount: 1,
            openAssignmentCount: 1,
          },
        ],
      };
    if (path.endsWith('/people-configuration'))
      return {
        projectManagerPersonId: 'person',
        groups: [
          { id: 'g', name: 'Équipe de contrôle', memberIds: ['person'] },
        ],
      };
    if (path.endsWith('/activity'))
      return {
        activity: [
          {
            id: 'e',
            action: 'project_created',
            label: 'Projet de contrôle',
            actorPersonId: 'person',
            actorName: 'Personne de contrôle',
            createdAt: 1,
            details: {},
          },
        ],
      };
    if (path.endsWith('/test-environment'))
      return {
        revision: 'preview-1',
        profile,
        capabilities: {
          enabled: true,
          domain: 'preview.example.test',
          runtimes: [
            { id: 'node', description: 'Node SDK' },
            { id: 'python', description: 'Python SDK' },
          ],
          storage: {
            workspaceMb: 1024,
            cacheMb: 512,
            temporaryMb: 256,
            dataMb: 256,
          },
        },
        viewer: { enabled: true },
      };
    if (path.endsWith('/location-transfers'))
      return { transfers: [], runs: [] };
    if (path.endsWith('/locations'))
      return {
        modelVersion: 1,
        connections: [
          {
            id: 'c',
            projectId: 'p',
            name: 'Dépôt de contrôle',
            protocol: 'git',
            address: 'https://example.test/repo',
            enabled: true,
            connectionState: 'connected',
            hasSecret: true,
            lastCheckedAt: null,
          },
        ],
        locations: [
          ...[
            {
              id: 'main',
              name: 'Principal',
              path: '/workspaces/p',
              kind: 'managed_local',
            },
            {
              id: 'secondary',
              name: 'Secondaire',
              path: '/workspaces/secondary',
              kind: 'attached_local',
            },
          ].map((w) => ({
            ...w,
            id: 'local:' + w.id,
            projectId: 'p',
            localWorkspaceId: w.id,
            connectionId: null,
            workingCopyId: null,
            accessMode: 'read_write',
            capabilities: { read: true, write: true, execute: false },
          })),
          {
            id: 'l',
            projectId: 'p',
            name: 'Dépôt de contrôle',
            kind: 'remote',
            path: '/',
            connectionId: 'c',
            localWorkspaceId: null,
            workingCopyId: null,
            accessMode: 'read_write',
            capabilities: { browse: true, read: true, write: true },
          },
        ],
        copies: [],
      };
    return {
      projects: [
        {
          id: 'p',
          name: 'Projet de contrôle',
          workspacePath: '/workspaces/p',
          createdAt: 1,
          updatedAt: 1,
          resources: [],
          mcpServerIds: [],
          appIds: [],
          agentThreads: [],
          workspaces: [
            {
              id: 'main',
              name: 'Principal',
              path: '/workspaces/p',
              primary: true,
            },
            {
              id: 'secondary',
              name: 'Secondaire',
              path: '/workspaces/secondary',
              primary: false,
            },
          ],
        },
      ],
    };
  },
}));
let client: QueryClient;
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  fixture.administrator = true;
  fixture.writes = [];
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  document.documentElement.classList.remove('dark');
});
const label = (key: string) =>
  i18n.t(translationKey(key), { ns: ['workspaces', 'common'] });
async function tab(key: string) {
  await page.getByRole('tab', { name: label(key), exact: true }).click();
}
function mount() {
  render(
    <QueryClientProvider client={client}>
      <div className="flex h-[850px] min-w-0 flex-col bg-background text-foreground">
        <ProjectRoute />
      </div>
    </QueryClientProvider>,
  );
}
function inspect(width: number) {
  const body = document.querySelector<HTMLElement>('[data-settings-body]');
  if (body) {
    const panel = body.closest('[data-settings-panel]')!;
    const fixed = panel
      .querySelector('[data-settings-heading],[data-settings-navigation]')!
      .getBoundingClientRect();
    const actions = panel
      .querySelector('[data-settings-actions]')!
      .getBoundingClientRect();
    body.scrollTop = body.scrollHeight;
    expect(
      panel
        .querySelector('[data-settings-heading],[data-settings-navigation]')!
        .getBoundingClientRect().top,
    ).toBe(fixed.top);
    expect(
      panel.querySelector('[data-settings-actions]')!.getBoundingClientRect()
        .top,
    ).toBe(actions.top);
    if (actions.height > 0)
      expect(body.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        actions.top + 1,
      );
    body.scrollTop = 0;
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
}
for (const width of [320, 390, 1100])
  test(`preserves all project tabs, fields and fixed actions at ${width}px`, async () => {
    await page.viewport(width, 900);
    document.documentElement.classList.add('dark');
    mount();
    await expect
      .element(
        page.getByRole('tab', {
          name: label('generalInformation'),
          exact: true,
        }),
      )
      .toBeVisible();
    inspect(width);
    await tab('people');
    await expect
      .element(page.getByText('Équipe de contrôle', { exact: true }))
      .toBeVisible();
    inspect(width);
    await tab('projectParticipants');
    await expect
      .element(
        page.getByRole('button', {
          name: label('removeParticipant'),
          exact: true,
        }),
      )
      .toBeVisible();
    expect(screen.getByPlaceholderText(label('searchPeople'))).toBeVisible();
    await tab('journal');
    await expect
      .element(page.getByRole('combobox', { name: label('filterByPerson') }))
      .toBeVisible();
    await tab('agentManagement');
    await expect
      .element(
        page.getByRole('combobox', { name: label('model'), exact: true }),
      )
      .toBeVisible();
    expect(
      screen.getByRole('combobox', { name: label('reasoningEffortcd32c0f5') }),
    ).toBeVisible();
    inspect(width);
    await tab('sharedProjectKnowledge');
    const instructions = await screen.findByLabelText(
      new RegExp(label('sharedInstructions')),
    );
    fireEvent.change(instructions, { target: { value: 'Brouillon conservé' } });
    await tab('projectKnowledge');
    expect(screen.getByLabelText(/Connaissances du projet/)).toHaveValue(
      'Faits de contrôle.',
    );
    await tab('projectDecisions');
    expect(screen.getByLabelText(/Décisions du projet/)).toHaveValue(
      'Décisions de contrôle.',
    );
    await tab('sharedInstructions');
    expect(
      screen.getByLabelText(new RegExp(label('sharedInstructions'))),
    ).toHaveValue('Brouillon conservé');
    inspect(width);
    await tab('memoryProposals');
    await expect
      .element(
        page.getByRole('textbox', { name: label('proposedContent') }).first(),
      )
      .toBeVisible();
    expect(screen.getAllByLabelText(label('proposedContent'))).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: label('reviewProposal') }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: label('acceptAndApply') }),
    ).toHaveLength(2);
    await tab('projectIntegrations');
    await expect
      .element(page.getByRole('switch', { name: 'Fixture MCP' }))
      .toBeVisible();
    await page.getByRole('switch', { name: 'Fixture MCP' }).click();
    await page
      .getByRole('button', { name: label('save'), exact: true })
      .click();
    await waitFor(() =>
      expect(fixture.writes.some((x) => x.path === '/p/mcp-servers')).toBe(
        true,
      ),
    );
    await tab('applications');
    await expect
      .element(page.getByRole('switch', { name: 'Fixture app' }))
      .toBeVisible();
    inspect(width);
    await page
      .getByRole('tab', {
        name: i18n.t('title', { ns: 'browser' }),
        exact: true,
      })
      .click();
    await expect
      .element(
        page.getByRole('textbox', {
          name: i18n.t('homeUrl', { ns: 'browser' }),
        }),
      )
      .toBeVisible();
    fireEvent.change(
      screen.getByRole('textbox', {
        name: i18n.t('homeUrl', { ns: 'browser' }),
      }),
      { target: { value: 'https://fixture.example.test' } },
    );
    await page
      .getByRole('button', {
        name: i18n.t('saveSettings', { ns: 'browser' }),
        exact: true,
      })
      .click();
    await waitFor(() =>
      expect(
        fixture.writes.some(
          (x) =>
            x.path === '/p/browser-settings' &&
            x.body.homeUrl === 'https://fixture.example.test',
        ),
      ).toBe(true),
    );
    inspect(width);
    await tab('workspacesLabel');
    const resourcesNavigation = screen.getByRole('tablist', {
      name: label('manageWorkspaces'),
    });
    expect(
      Array.from(resourcesNavigation.querySelectorAll('[role=tab]')).map(
        (t) => t.textContent,
      ),
    ).toEqual([
      label('externalResources'),
      label('projectLocationsTab'),
      label('workspaceTransfers'),
      label('gitDeliverablesTitle'),
    ]);
    await tab('projectLocationsTab');
    await expect
      .element(page.getByText('/workspaces/secondary', { exact: true }))
      .toBeVisible();
    expect(screen.getByRole('button', { name: label('detach') })).toBeVisible();
    inspect(width);
    await page
      .getByRole('button', { name: label('addLocalLocation'), exact: true })
      .click();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^SSH/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: label('cancel') }));
    await tab('externalResources');
    await expect
      .element(page.getByText('Dépôt de contrôle', { exact: true }))
      .toBeVisible();
    inspect(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/project-connections-${width}.png`,
    });
    await page
      .getByRole('button', { name: label('addAConnection'), exact: true })
      .click();
    await page.getByRole('button', { name: /^SSH/ }).click();
    await expect
      .element(
        page.getByRole('checkbox', {
          name: label('connectionAvailableToAgent'),
        }),
      )
      .toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: label('cancel') }));
    await tab('workspaceTransfers');
    await expect
      .element(page.getByRole('heading', { name: label('workspaceTransfers') }))
      .toBeVisible();
    inspect(width);
    await page
      .getByRole('tab', {
        name: i18n.t('title', { ns: 'previews' }),
        exact: true,
      })
      .click();
    await expect
      .element(
        page.getByRole('combobox', {
          name: i18n.t('runtime', { ns: 'previews' }),
        }),
      )
      .toBeVisible();
    for (const key of [
      'directory',
      'install',
      'build',
      'start',
      'port',
      'path',
      'updateMode',
    ])
      expect(
        screen.getByLabelText(i18n.t(translationKey(key), { ns: 'previews' })),
      ).toBeVisible();
    await page
      .getByRole('tab', {
        name: i18n.t('resourcesTab', { ns: 'previews' }),
        exact: true,
      })
      .click();
    for (const key of ['lifetime', 'memory', 'cpus'])
      expect(
        screen.getByLabelText(i18n.t(translationKey(key), { ns: 'previews' })),
      ).toBeVisible();
    inspect(width);
    await page
      .getByRole('tab', {
        name: i18n.t('advancedTab', { ns: 'previews' }),
        exact: true,
      })
      .click();
    expect(
      screen.getByLabelText(i18n.t('environment', { ns: 'previews' })),
    ).toHaveValue(JSON.stringify({ TEST_KEY: '[stored]' }, null, 2));
    expect(
      screen.getByLabelText(i18n.t('services', { ns: 'previews' })),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: i18n.t('save', { ns: 'previews' }),
        exact: true,
      })
      .click();
    await waitFor(() =>
      expect(
        fixture.writes.some(
          (x) =>
            x.path === '/p/test-environment' &&
            (x.body.profile as { env: unknown }).env &&
            x.body.expectedRevision === 'preview-1',
        ),
      ).toBe(true),
    );
    inspect(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/project-settings-${width}.png`,
    });
  });

test('retains participant read-only access without exposing administrator operations', async () => {
  fixture.administrator = false;
  await page.viewport(390, 900);
  mount();
  await expect
    .element(
      page.getByRole('tab', { name: label('agentManagement'), exact: true }),
    )
    .toBeVisible();
  expect(
    screen.queryByRole('tab', { name: label('workspacesLabel') }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('tab', { name: i18n.t('title', { ns: 'browser' }) }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('tab', { name: i18n.t('title', { ns: 'previews' }) }),
  ).not.toBeInTheDocument();
  await tab('agentManagement');
  expect(screen.getByRole('combobox', { name: label('model') })).toBeDisabled();
  expect(
    screen.queryByRole('tab', { name: label('memoryProposals') }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('tab', { name: label('projectIntegrations') }),
  ).not.toBeInTheDocument();
  await tab('sharedProjectKnowledge');
  expect(
    await screen.findByLabelText(new RegExp(label('sharedInstructions'))),
  ).toHaveAttribute('readonly');
  expect(
    screen.queryByRole('button', { name: label('save') }),
  ).not.toBeInTheDocument();
});
