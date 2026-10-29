/** Real components and layout; API responses use synthetic, account-free data. */
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { AgentPreviewDialog } from './agent-preview-dialog';
import { ProjectPreviewSettings } from '../projects/project-preview-settings';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const data = vi.hoisted(() => ({
  administrator: true,
  calls: [] as string[],
  state: 'running',
  ready: true,
  environment: { TEST_KEY: '[stored]' },
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: data.administrator }),
}));
vi.mock('@/lib/projects-api', () => ({
  projectsApi: async (path: string) => {
    data.calls.push(path);
    if (path.endsWith('/test-environment'))
      return {
        revision: 'revision',
        profile: {
          enabled: true,
          agentManaged: false,
          agentRuntimes: ['node'],
          runtime: 'node',
          directory: '.',
          install: 'npm ci',
          build: '',
          start: 'npm run dev -- --host 0.0.0.0 --port 5173 --strictPort',
          port: 5173,
          path: '/',
          updateMode: 'hot',
          env: data.environment,
          services: [],
          memoryMb: 1024,
          cpus: 1,
          lifetimeMinutes: 60,
        },
        capabilities: {
          enabled: true,
          domain: 'preview.example.org',
          runtimes: [
            { id: 'node', description: 'Node SDK' },
            { id: 'python', description: 'Python SDK' },
          ],
        },
        viewer: { enabled: true },
      };
    if (path.endsWith('/logs'))
      return { text: '<script>This is untrusted application output</script>' };
    return {
      preview: {
        state: data.state,
        ready: data.ready,
        url: 'https://22222222-2222-4222-8222-222222222222.preview.example.org/',
        sourcePath: '/workspaces/project/sources/.external/agent-working-copy',
        error: null,
        expiresAt: Date.now() + 3600000,
        lastSyncedAt: Date.now(),
        updateMode: 'hot',
        requiresRestart: false,
      },
    };
  },
}));
let client: QueryClient;
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  data.administrator = true;
  data.calls = [];
  data.state = 'running';
  data.ready = true;
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  document.documentElement.classList.add('dark');
});
test('a running process is not presented as an openable HTTP preview', async () => {
  data.ready = false;
  render(
    <QueryClientProvider client={client}>
      <AgentPreviewDialog
        projectId="project"
        threadId="agent"
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>,
  );
  await expect
    .element(
      page.getByText('Processus démarré — attente d’une réponse HTTP valide'),
    )
    .toBeVisible();
  expect(screen.queryByRole('button', { name: 'Ouvrir l’aperçu' })).toBeNull();
});
for (const width of [1440, 390])
  test(`standing agent-preview authorization fits ${width}px and keeps caps human-controlled`, async () => {
    await page.viewport(width, 900);
    render(
      <QueryClientProvider client={client}>
        <main className="p-4">
          <ProjectPreviewSettings projectId="project" />
        </main>
      </QueryClientProvider>,
    );
    await expect
      .element(
        page.getByRole('checkbox', {
          name: 'Laisser les agents préparer et gérer leur environnement de test',
        }),
      )
      .toBeVisible();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Laisser les agents préparer et gérer leur environnement de test',
      }),
    );
    expect(
      screen.queryByLabelText('Commande de démarrage (écoute sur 0.0.0.0)'),
    ).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Node SDK' })).toBeChecked();
    expect(
      screen.getByLabelText('Mémoire maximale de l’application (Mio)'),
    ).toHaveValue(1024);
    expect(document.body.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/preview-delegation-${width}.png`,
    });
  });
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  document.body.style.removeProperty('font-family');
});
for (const width of [1440, 390])
  test(`preview controls fit the ${width}px viewport without horizontal scrolling`, async () => {
    await page.viewport(width, 900);
    render(
      <QueryClientProvider client={client}>
        <AgentPreviewDialog
          projectId="project"
          threadId="agent"
          open
          onOpenChange={() => {}}
        />
      </QueryClientProvider>,
    );
    await expect
      .element(page.getByRole('button', { name: 'Ouvrir l’aperçu' }))
      .toBeVisible();
    const dialog = screen.getByRole('dialog');
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    const bounds = dialog.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(width);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Journaux de l’application (contenu non fiable)',
      }),
    );
    await expect
      .element(
        page.getByText(
          '<script>This is untrusted application output</script>',
          { exact: true },
        ),
      )
      .toBeVisible();
    expect(dialog.querySelector('script')).toBeNull();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Arrêter' }));
    expect(confirm).toHaveBeenCalled();
    expect(data.calls.some((p) => p.endsWith('/stop'))).toBe(false);
    await page.screenshot({
      path: `../../../.vitest-screenshots/preview-${width}.png`,
    });
  });
test('standard project members have viewing controls but no execution buttons', async () => {
  data.administrator = false;
  await page.viewport(1000, 800);
  render(
    <QueryClientProvider client={client}>
      <AgentPreviewDialog
        projectId="project"
        threadId="agent"
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>,
  );
  await expect
    .element(page.getByRole('button', { name: 'Ouvrir l’aperçu' }))
    .toBeVisible();
  expect(screen.queryByRole('button', { name: 'Arrêter' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Recréer' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Synchroniser maintenant' }),
  ).toBeNull();
});
test('project profile supports generic runtimes and preserves masked settings on mobile', async () => {
  await page.viewport(390, 900);
  render(
    <QueryClientProvider client={client}>
      <main className="p-4">
        <ProjectPreviewSettings projectId="project" />
      </main>
    </QueryClientProvider>,
  );
  await expect
    .element(page.getByRole('button', { name: 'Enregistrer le profil' }))
    .toBeVisible();
  const runtime = screen.getByRole('combobox', {
    name: 'Environnement d’exécution autorisé',
  });
  expect(runtime).toHaveValue('node');
  // WebKit/GTK native widgets can paint a white surface over dark CSS colors.
  expect(getComputedStyle(runtime).appearance).toBe('none');
  expect(
    screen.getByRole('combobox', { name: 'Application des modifications' }),
  ).toHaveValue('hot');
  const body = document.body;
  expect(body.scrollWidth).toBeLessThanOrEqual(390);
  fireEvent.click(
    screen.getByText('Configuration avancée : variables et services de test'),
  );
  expect(
    screen.getByLabelText('Variables de l’application (objet JSON)'),
  ).toHaveValue(JSON.stringify({ TEST_KEY: '[stored]' }, null, 2));
  await page.screenshot({
    path: '../../../.vitest-screenshots/preview-settings-mobile.png',
  });
});

test('mobile preview controls also fit with wider system fallback font metrics', async () => {
  await page.viewport(390, 900);
  document.body.style.fontFamily = 'monospace';
  const dialogView = render(
    <QueryClientProvider client={client}>
      <AgentPreviewDialog
        projectId="project"
        threadId="agent"
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>,
  );
  await expect
    .element(page.getByRole('button', { name: 'Ouvrir l’aperçu' }))
    .toBeVisible();
  const dialog = screen.getByRole('dialog');
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
  dialogView.unmount();
  render(
    <QueryClientProvider client={client}>
      <main className="p-4">
        <ProjectPreviewSettings projectId="project" />
      </main>
    </QueryClientProvider>,
  );
  await expect
    .element(page.getByRole('button', { name: 'Enregistrer le profil' }))
    .toBeVisible();
  const overflow = Array.from(document.querySelectorAll('main *'))
    .filter(
      (el) =>
        el.getBoundingClientRect().right > 390 ||
        el.scrollWidth > el.clientWidth,
    )
    .map((el) => ({
      tag: el.tagName,
      label: el.textContent?.slice(0, 80),
      width: el.getBoundingClientRect().width,
      scroll: el.scrollWidth,
      client: el.clientWidth,
      overflow: getComputedStyle(el).overflow,
      whiteSpace: getComputedStyle(el).whiteSpace,
    }));
  expect(
    document.body.scrollWidth,
    JSON.stringify(overflow),
  ).toBeLessThanOrEqual(390);
  const mode = screen.getByRole('combobox', {
    name: 'Application des modifications',
  });
  expect(mode).toHaveValue('hot');
  fireEvent.change(mode, { target: { value: 'manual' } });
  expect(mode).toHaveValue('manual');
  fireEvent.change(mode, { target: { value: 'hot' } });
  expect(document.body.scrollWidth).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: '../../../.vitest-screenshots/preview-fallback-mobile.png',
  });
});
