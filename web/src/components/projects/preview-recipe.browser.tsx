/** Real dialogs and form events; synthetic data, no running preview or account. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { ProjectPreviewSettings } from './project-preview-settings';
import { AgentPreviewPanel } from '../chat/agent-preview-panel';
import type { PreviewProfile } from '../../../../runtime/preview-profile.cjs';
const fixture = vi.hoisted(() => ({
  calls: [] as { path: string; body: Record<string, unknown> }[],
  failSave: false,
  missing: false,
  revision: 'policy:recipe:source',
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: true }),
}));
const profile: PreviewProfile = {
  enabled: true,
  agentManaged: true,
  agentRuntimes: ['node'],
  runtime: 'node',
  directory: 'web',
  install: 'npm ci',
  build: 'npm run build',
  start: 'npm run dev -- --host 0.0.0.0',
  port: 3000,
  path: '/',
  env: { TEST_PASSWORD: '[stored]' },
  memoryMb: 1024,
  cpus: 1,
  lifetimeMinutes: 300,
  services: [
    {
      name: 'fixture-api',
      runtime: 'node',
      command: 'node fixture.js',
      env: { FIXTURE_KEY: '[stored]' },
    },
  ],
  updateMode: 'hot',
};
vi.mock('@/lib/projects-api', () => ({
  projectsQueryKey: ['projects'],
  projectsApi: async (path = '', init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    fixture.calls.push({ path, body });
    if (!path)
      return {
        projects: [
          {
            id: 'project',
            agentThreads: [{ threadId: 'agent', title: 'Développeur' }],
          },
        ],
      };
    if (path.endsWith('/test-environment/recipes'))
      return { agents: [{ threadId: 'agent' }] };
    if (path.endsWith('/test-environment'))
      return {
        profile,
        revision: 'policy',
        capabilities: {
          enabled: true,
          domain: 'preview.example',
          runtimes: [{ id: 'node', description: 'Node.js 22' }],
        },
        viewer: { enabled: true },
      };
    if (path.endsWith('/recipe')) {
      if (init?.method === 'PUT') {
        if (fixture.failSave) throw new Error('PREVIEW_STOP_BEFORE_PREPARE');
        return { state: 'prepared' };
      }
      return {
        profile,
        policyRevision: 'policy',
        recipeRevision: 'recipe',
        revision: fixture.revision,
        agentManaged: true,
        stale: false,
        sourcePath: '/workspaces/project/source',
      };
    }
    if (path.endsWith('/prerequisites'))
      return {
        available: true,
        missingConfiguration: [],
        preparation: { required: false },
      };
    if (path.endsWith('/start')) return { preview: null };
    if (path.endsWith('/containers')) return { containers: [] };
    return {
      preview: fixture.missing
        ? {
            runId: 'old',
            state: 'stopped',
            error: 'PREVIEW_NOT_FOUND',
            ready: false,
          }
        : null,
      defaultLifetimeMinutes: 300,
    };
  },
}));
let client: QueryClient;
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  fixture.calls = [];
  fixture.failSave = false;
  fixture.missing = false;
  fixture.revision = 'policy:recipe:source';
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  document.documentElement.classList.remove('dark');
});
for (const width of [1280, 390]) {
  test(`agent recipe remains visible and editable with delegation at ${width}px`, async () => {
    await page.viewport(width, 900);
    document.documentElement.classList.add('dark');
    render(
      <QueryClientProvider client={client}>
        <div className="h-screen p-3">
          <ProjectPreviewSettings projectId="project" />
        </div>
      </QueryClientProvider>,
    );
    const edit = await screen.findByRole('button', {
      name: 'Consulter et modifier',
    });
    expect(screen.getByText('Développeur')).toBeTruthy();
    fireEvent.click(edit);
    const dialog = await screen.findByRole('dialog');
    const start = await within(dialog).findByLabelText(
      'Commande de démarrage (écoute sur 0.0.0.0)',
    );
    expect((start as HTMLTextAreaElement).value).toBe(profile.start);
    fireEvent.change(start, {
      target: { value: 'npm run dev -- --port 4000' },
    });
    fireEvent.click(
      within(dialog).getByText(
        'Configuration avancée : variables et services de test',
      ),
    );
    expect(
      (
        within(dialog).getByLabelText(
          'Variables de l’application (objet JSON)',
        ) as HTMLTextAreaElement
      ).value,
    ).toContain('[stored]');
    await expect.poll(() => getComputedStyle(dialog).opacity).toBe('1');
    await page.screenshot({
      path: `../../../.vitest-screenshots/preview-recipe-edit-${width}.png`,
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Enregistrer la recette' }),
    );
    await waitFor(() =>
      expect(
        fixture.calls.some(
          (c) => c.path.endsWith('/recipe') && c.body.requestId,
        ),
      ).toBe(true),
    );
    const saved = fixture.calls.find(
      (c) => c.path.endsWith('/recipe') && c.body.requestId,
    )!.body;
    expect(saved).toMatchObject({
      policyRevision: 'policy',
      expectedRevision: 'recipe',
      recipe: {
        start: 'npm run dev -- --port 4000',
        env: { TEST_PASSWORD: '[stored]' },
      },
    });
    expect((saved.recipe as Record<string, unknown>).memoryMb).toBeUndefined();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
  });
  test(`start shows all commands and requires confirmation at ${width}px`, async () => {
    await page.viewport(width, 900);
    fixture.missing = true;
    render(
      <QueryClientProvider client={client}>
        <div className="h-screen">
          <AgentPreviewPanel projectId="project" threadId="agent" active />
        </div>
      </QueryClientProvider>,
    );
    const start = await screen.findByRole('button', { name: 'Démarrer' });
    await waitFor(() =>
      expect((start as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(start);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(profile.start);
    expect(within(dialog).getByText('npm ci')).toBeTruthy();
    expect(within(dialog).getByText('npm run build')).toBeTruthy();
    expect(within(dialog).getByText('node fixture.js')).toBeTruthy();
    expect(dialog.textContent).not.toContain('TEST_PASSWORD');
    expect(fixture.calls.some((c) => c.path.endsWith('/start'))).toBe(false);
    await expect.poll(() => getComputedStyle(dialog).opacity).toBe('1');
    await page.screenshot({
      path: `../../../.vitest-screenshots/preview-launch-review-${width}.png`,
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Confirmer le démarrage' }),
    );
    await waitFor(() =>
      expect(fixture.calls.some((c) => c.path.endsWith('/start'))).toBe(true),
    );
    expect(
      fixture.calls.find((c) => c.path.endsWith('/start'))!.body,
    ).toMatchObject({
      expectedRevision: 'policy:recipe:source',
      lifetimeMinutes: 300,
    });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
}
test('a rejected recipe save keeps the draft and displays the stop prerequisite', async () => {
  fixture.failSave = true;
  render(
    <QueryClientProvider client={client}>
      <ProjectPreviewSettings projectId="project" />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Consulter et modifier' }),
  );
  const dialog = await screen.findByRole('dialog');
  const command = await within(dialog).findByLabelText(
    'Commande de démarrage (écoute sur 0.0.0.0)',
  );
  fireEvent.change(command, { target: { value: 'node edited.js' } });
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Enregistrer la recette' }),
  );
  expect(await within(dialog).findByRole('alert')).toHaveProperty(
    'textContent',
    'PREVIEW_STOP_BEFORE_PREPARE',
  );
  expect((command as HTMLTextAreaElement).value).toBe('node edited.js');
});
