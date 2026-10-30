/** Real components and layout; API responses use synthetic, account-free data. */
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { AgentPreviewDialog } from './agent-preview-dialog';
import { ProjectPreviewSettings } from '../projects/project-preview-settings';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import type { PreviewStorageLimits } from '../../../../runtime/preview-storage.cjs';
// Synthetic wire response, not a Node/CommonJS runtime imported into a browser.
const storageLimits: PreviewStorageLimits = {
  backend: 'tmpfs',
  memoryCharged: true,
  workspaceMb: 4096,
  cacheMb: 2048,
  temporaryMb: 512,
  dataMb: 256,
  inodesPerVolume: 524288,
};
const data = vi.hoisted(() => ({
  administrator: true,
  calls: [] as string[],
  state: 'running',
  lifetimeMinutes: 300 as number | null,
  defaultLifetimeMinutes: 300 as number | null,
  bodies: [] as { path: string; value: unknown }[],
  ready: true,
  environment: { TEST_KEY: '[stored]' },
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: data.administrator }),
}));
vi.mock('@/lib/projects-api', () => ({
  projectsApi: async (path: string, init?: RequestInit) => {
    if (init?.body) {
      const body = JSON.parse(String(init.body));
      data.bodies.push({ path, value: body });
      if (path.endsWith('/lifetime'))
        data.lifetimeMinutes = body.lifetimeMinutes;
    }
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
          lifetimeMinutes: 300,
        },
        capabilities: {
          enabled: true,
          storage: storageLimits,
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
      defaultLifetimeMinutes: data.defaultLifetimeMinutes,
      preview:
        data.state === 'absent'
          ? null
          : {
              state: data.state,
              ready: data.ready,
              url: 'https://22222222-2222-4222-8222-222222222222.preview.example.org/',
              sourcePath:
                '/workspaces/project/sources/.external/agent-working-copy',
              error: null,
              expiresAt:
                data.lifetimeMinutes === null
                  ? null
                  : Date.now() + data.lifetimeMinutes * 60000,
              lifetimeMinutes: data.lifetimeMinutes,
              lastSyncedAt: Date.now(),
              updateMode: 'hot',
              requiresRestart: false,
              storage: { limits: storageLimits, observation: null },
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
  data.bodies = [];
  data.lifetimeMinutes = 300;
  data.defaultLifetimeMinutes = 300;
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
  expect(
    screen.queryByRole('textbox', {
      name: 'Adresse de l’environnement de test',
    }),
  ).toBeNull();
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
    expect(
      screen.getByLabelText('Mémoire maximale de l’application (Mio)'),
    ).toHaveAttribute('max', '8192');
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
    const address = screen.getByRole('textbox', {
      name: 'Adresse de l’environnement de test',
    });
    expect(address).toHaveValue(
      'https://22222222-2222-4222-8222-222222222222.preview.example.org/',
    );
    expect(address).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Copier l’URL' })).toBeVisible();
    expect(address.getBoundingClientRect().top).toBeLessThan(
      screen
        .getByRole('region', { name: 'Stockage du runtime' })
        .getBoundingClientRect().top,
    );
    expect(
      screen.getByRole('region', { name: 'Stockage du runtime' }),
    ).toBeVisible();
    expect(screen.getByText(/Les caches sont dans \/cache/)).toBeVisible();
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
  expect(
    screen.queryByRole('combobox', { name: 'Durée de disponibilité' }),
  ).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Appliquer la durée' }),
  ).toBeNull();
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

test('duration defaults to five hours and an active preview can switch to never without recreation', async () => {
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
  const select = await screen.findByRole('combobox', {
    name: 'Durée de disponibilité',
  });
  await expect
    .element(page.getByRole('combobox', { name: 'Durée de disponibilité' }))
    .toBeEnabled();
  const address = await screen.findByRole('textbox', {
    name: 'Adresse de l’environnement de test',
  });
  const stableUrl = (address as HTMLInputElement).value;
  expect(stableUrl).toBe(
    'https://22222222-2222-4222-8222-222222222222.preview.example.org/',
  );
  expect((select as HTMLSelectElement).value).toBe('300');
  expect(
    [...select.querySelectorAll('option')].map((option) => option.value),
  ).toEqual(['60', '180', '300', '600', '1440', 'never']);
  fireEvent.change(select, { target: { value: 'never' } });
  fireEvent.click(screen.getByRole('button', { name: 'Appliquer la durée' }));
  await expect.poll(() => data.bodies.length).toBe(1);
  expect(data.bodies[0]).toEqual({
    path: '/project/agents/agent/preview/lifetime',
    value: { lifetimeMinutes: null, requestId: expect.any(String) },
  });
  await expect
    .element(page.getByText('Arrêt automatique: Jamais'))
    .toBeVisible();
  expect(address).toHaveValue(stableUrl);
  expect(screen.getByRole('button', { name: 'Copier l’URL' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Ouvrir l’aperçu' })).toBeVisible();
  expect(data.calls.some((path) => /\/(start|refresh|stop)$/.test(path))).toBe(
    false,
  );
});

test('the initial launch preserves an administrator’s configured unlimited default', async () => {
  data.state = 'absent';
  data.defaultLifetimeMinutes = null;
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
    .element(page.getByRole('button', { name: 'Démarrer', exact: true }))
    .toBeVisible();
  await expect
    .poll(
      () =>
        (
          screen.getByRole('combobox', {
            name: 'Durée de disponibilité',
          }) as HTMLSelectElement
        ).value,
    )
    .toBe('never');
  fireEvent.click(screen.getByRole('button', { name: 'Démarrer' }));
  await expect.poll(() => data.bodies.length).toBe(1);
  expect(data.bodies[0]).toMatchObject({
    path: '/project/agents/agent/preview/start',
    value: { lifetimeMinutes: null },
  });
});
