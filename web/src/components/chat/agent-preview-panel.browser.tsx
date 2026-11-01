/** Real layout and xterm; synthetic scoped API responses, no Docker or accounts. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page, userEvent } from 'vitest/browser';
import {
  AgentPreviewPanel,
  type PreviewContainer,
} from './agent-preview-panel';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

const api = vi.hoisted(() => ({
  calls: [] as { path: string; body: Record<string, unknown> }[],
  running: true,
  admin: true,
  startupTimeout: false,
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: api.admin }),
}));
const items: PreviewContainer[] = Array.from({ length: 6 }, (_, i) => ({
  component: i ? 'preview-service' + i : 'preview-app',
  name: i ? 'service' + i : 'Application',
  image: 'example.org/runtime@sha256:' + 'a'.repeat(64),
  state: 'running',
  startedAt: '2026-10-31T12:00:00Z',
  cpuPercent: 1.4,
  memoryBytes: 184 * 1024 ** 2,
  terminalAvailable: true,
}));
vi.mock('@/lib/projects-api', () => ({
  projectsApi: async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    api.calls.push({ path, body });
    if (path.endsWith('/start')) api.running = true;
    if (path.endsWith('/stop')) api.running = false;
    if (path.endsWith('/containers')) return { containers: items };
    if (path.includes('/container-logs'))
      return {
        text: Array.from(
          { length: 100 },
          (_, i) =>
            `${i} ${path.includes('service3') ? 'service3' : 'Application'} <script>untrusted</script> GET / 200`,
        ).join('\n'),
      };
    if (path.endsWith('/terminal'))
      return body.action === 'open'
        ? { sessionId: 'synthetic-session' }
        : {
            text: body.offset === 0 ? '/workspace $ ' : '',
            offset: 13,
            sequence: body.sequence,
            ended: false,
          };
    return {
      defaultLifetimeMinutes: 180,
      preview: api.running
        ? {
            runId: 'synthetic-run',
            state: api.startupTimeout ? 'failed' : 'running',
            ready: !api.startupTimeout,
            url: api.startupTimeout ? null : 'https://test.preview.example/',
            sourcePath: '/workspace',
            error: api.startupTimeout ? 'PREVIEW_STARTUP_TIMEOUT' : null,
            expiresAt: null,
            lastSyncedAt: Date.now(),
            updateMode: 'hot',
            requiresRestart: false,
            storage: {
              limits: {
                backend: 'tmpfs',
                memoryCharged: true,
                workspaceMb: 4096,
                cacheMb: 2048,
                temporaryMb: 512,
                dataMb: 256,
                inodesPerVolume: 1000,
              },
              observation: {
                checkedAt: Date.now(),
                mounts: ['workspace', 'cache', 'temporary', 'data'].map(
                  (role) => ({
                    role,
                    path: '/' + role,
                    totalBytes: 4096 * 1024 ** 2,
                    availableBytes: 2400 * 1024 ** 2,
                    totalInodes: 1000,
                    availableInodes: 900,
                    cause: null,
                  }),
                ),
              },
            },
          }
        : null,
    };
  },
}));
let client: QueryClient;
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  api.calls = [];
  api.running = true;
  api.admin = true;
  api.startupTimeout = false;
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  document.documentElement.classList.add('dark');
});
afterEach(() => {
  cleanup();
  client.clear();
});
function mount(active = true) {
  return render(
    <QueryClientProvider client={client}>
      <div style={{ height: 740 }}>
        <AgentPreviewPanel projectId="p" threadId="t" active={active} />
      </div>
    </QueryClientProvider>,
  );
}
test('startup timeout is an explicit failure with retained diagnostics, not an endless running badge', async () => {
  api.startupTimeout = true;
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Le démarrage n’a pas abouti dans le délai de 20 minutes',
  );
  expect(screen.getByRole('status')).toHaveTextContent('Échec');
  expect(await screen.findByLabelText('Logs')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Terminal' })).toBeDisabled();
});
for (const width of [1180, 390])
  test(`unified preview fits ${width}px, three rows and independently scrolling console`, async () => {
    await page.viewport(width, 800);
    mount();
    const row = await screen.findByRole('button', { name: /service3/ });
    const list = screen.getByLabelText(
      'Conteneurs — trois lignes visibles maximum',
    );
    expect(list.clientHeight).toBe(216);
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    const logs = await screen.findByLabelText('Logs');
    await waitFor(() =>
      expect(logs.scrollHeight).toBeGreaterThan(logs.clientHeight),
    );
    const before = logs.clientHeight;
    fireEvent.click(screen.getByRole('button', { name: 'Stockage' }));
    await waitFor(() => expect(logs.clientHeight).toBeLessThan(before));
    await page.screenshot({
      path: `../../../.vitest-screenshots/preview-workspace-storage-${width}.png`,
    });
    fireEvent.click(row);
    await waitFor(() => expect(logs.textContent).toContain('service3'));
    expect(row).toHaveAttribute('aria-pressed', 'true');
    expect(row.querySelector('button')).toBeNull();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stockage' }));
    await page.screenshot({
      path: `../../../.vitest-screenshots/preview-workspace-${width}.png`,
    });
  });
test.each(['burst', 'fragmented'] as const)(
  'direct terminal input (%s) is scoped and clicking a container restores logs',
  async (typing) => {
    await page.viewport(1180, 800);
    mount();
    await screen.findByRole('button', { name: /Application/ });
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    await waitFor(() => {
      const input = document.querySelector('.xterm-helper-textarea');
      expect(input).not.toBeNull();
      expect(document.activeElement).toBe(input);
      expect(api.calls.some((c) => c.body.action === 'exchange')).toBe(true);
    });
    if (typing === 'fragmented') {
      // A real user may pause across the transport's 250 ms flush boundary.
      // Waiting for receipt forces separate requests without arbitrary sleeps.
      for (const key of ['p', 'w', 'd']) {
        await userEvent.keyboard(key);
        await waitFor(() =>
          expect(
            api.calls.some(
              (c) => c.body.action === 'exchange' && c.body.data === key,
            ),
          ).toBe(true),
        );
      }
      await userEvent.keyboard('{Enter}');
    } else await userEvent.keyboard('pwd{Enter}');
    const inputExchanges = () =>
      api.calls.filter(
        (c) =>
          c.body.action === 'exchange' &&
          typeof c.body.data === 'string' &&
          c.body.data.length > 0,
      );
    // Transport boundaries are not command boundaries: assert the complete,
    // ordered stream, including Enter, instead of requiring one "pwd" packet.
    await waitFor(() =>
      expect(
        inputExchanges()
          .map((c) => c.body.data)
          .join(''),
      ).toBe('pwd\r'),
    );
    const sent = inputExchanges();
    expect(sent.map((c) => c.body.sequence)).toEqual(sent.map((_, i) => i + 1));
    for (const { body } of sent)
      expect(body).toMatchObject({
        runId: 'synthetic-run',
        component: 'preview-app',
        sessionId: 'synthetic-session',
      });
    if (typing === 'fragmented') expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(api.calls.find((c) => c.body.action === 'open')?.body).toMatchObject(
      {
        runId: 'synthetic-run',
        component: 'preview-app',
      },
    );
    await page.screenshot({
      path: `../../../.vitest-screenshots/preview-workspace-terminal-${typing}.png`,
    });
    fireEvent.click(screen.getByRole('button', { name: /service3/ }));
    await waitFor(() => expect(document.querySelector('.xterm')).toBeNull());
    expect(screen.getByRole('button', { name: 'Logs' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() =>
      expect(api.calls.some((c) => c.body.action === 'close')).toBe(true),
    );
  },
);
test('not started is a useful empty state and inactive panels do not poll', async () => {
  api.running = false;
  mount();
  await screen.findByText('Aucun environnement démarré');
  expect(
    screen.queryByLabelText('Console du conteneur sélectionné'),
  ).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Ouvrir l’aperçu' }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Démarrer' }));
  await screen.findByRole('button', { name: /Application/ });
  cleanup();
  client.clear();
  api.calls = [];
  mount(false);
  expect(api.calls).toHaveLength(0);
});
test('read-only viewers have no execution or terminal controls', async () => {
  api.admin = false;
  mount();
  await screen.findByRole('button', { name: /Application/ });
  expect(screen.queryByRole('button', { name: 'Arrêter' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull();
});
