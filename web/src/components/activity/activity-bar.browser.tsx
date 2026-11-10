/** Responsive layout and menu tested with synthetic activity only. */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActivityProvider } from './activity-provider';
import { ActivityBar, ActivityButton } from './activity-bar';
import { useConnectionStore } from '@/stores/connection-store';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const navigation = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigation.navigate,
}));
vi.mock('@/lib/session-recovery', () => ({ useSessionPaused: () => false }));
const data = {
  agents: {
    running: 2,
    waiting: 1,
    total: 3,
    stale: false,
    refreshedAt: 1,
    items: [
      {
        threadId: 'waiting-agent',
        name: 'Agent à confirmer',
        state: 'waiting',
      },
      {
        threadId: 'active-agent',
        name: 'Agent de rédaction',
        state: 'running',
      },
      {
        threadId: 'another-agent',
        name: 'Agent de relecture',
        state: 'running',
      },
    ],
  },
  operations: {
    total: 1,
    items: [{ id: 'media', kind: 'media', threadId: 'active-agent' }],
  },
  installation: {
    environment: 'development',
    version: '0.7.5',
    channel: 'edge',
  },
};
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  navigation.navigate.mockReset();
  localStorage.clear();
});
async function setup(width: number) {
  await page.viewport(width, 850);
  await i18nReady;
  await i18n.changeLanguage('fr');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(data))),
      ),
  );
  useConnectionStore.setState({ connected: true });
  client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ActivityProvider owner="synthetic">
        <div style={{ height: '100dvh' }} className="flex min-h-0 flex-col">
          <header className="flex h-11 shrink-0 justify-end border-b">
            <span className="mr-auto p-2">Mergeron</span>
            <ActivityButton />
          </header>
          <div className="flex min-h-0 flex-1">
            <aside className="hidden w-56 border-r lg:block">Projets</aside>
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-auto p-5">
                <h1>Conversation</h1>
                <div className="mt-4 rounded-xl border p-4">
                  Les informations restent accessibles sans recouvrir le
                  message.
                </div>
              </div>
              <textarea
                aria-label="Message"
                className="m-3 h-24 shrink-0 rounded-xl border p-3"
                defaultValue="Brouillon conservé"
              />
            </main>
          </div>
          <ActivityBar />
        </div>
      </ActivityProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(client.isFetching()).toBe(0));
}
for (const width of [1280, 820, 390])
  test(`status bar and menu at ${width}px`, async () => {
    await setup(width);
    const bar = screen.queryByTestId('platform-activity-bar');
    if (width === 390) expect(bar).toBeNull();
    else {
      expect(bar).not.toBeNull();
      expect(bar!.getBoundingClientRect().height).toBe(
        width === 1280 ? 28 : 32,
      );
      expect(
        screen.getByRole('textbox', { name: 'Message' }).getBoundingClientRect()
          .bottom,
      ).toBeLessThanOrEqual(bar!.getBoundingClientRect().top);
      expect(bar!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        window.innerHeight,
      );
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      window.innerWidth,
    );
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(
      window.innerHeight,
    );
    await page.screenshot({
      path: `../../../.vitest-screenshots/activity-${width}-${navigator.userAgent.includes('Chrome') ? 'chromium' : 'webkit'}.png`,
    });
    fireEvent.click(
      screen.getAllByRole('button', { name: 'État et activité' })[0],
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'État et activité',
    });
    await waitFor(() => expect(getComputedStyle(dialog).opacity).toBe('1'));
    expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      window.innerHeight,
    );
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(
      screen.getAllByRole('button', { name: 'État et activité' })[0],
    );
    const reopened = await screen.findByRole('dialog', {
      name: 'État et activité',
    });
    await waitFor(() => expect(getComputedStyle(reopened).opacity).toBe('1'));
    expect(screen.getByText('Agent à confirmer')).toBeTruthy();
    expect(screen.getByText(/mises à jour du serveur/)).toBeTruthy();
    await page.screenshot({
      path: `../../../.vitest-screenshots/activity-menu-${width}-${navigator.userAgent.includes('Chrome') ? 'chromium' : 'webkit'}.png`,
    });
    if (width === 820) {
      fireEvent.click(
        screen.getByRole('checkbox', {
          name: 'Afficher la barre sur cette tablette',
        }),
      );
      expect(screen.queryByTestId('platform-activity-bar')).toBeNull();
      expect(localStorage.getItem('mergeron:activity-bar:synthetic')).toBe(
        'hidden',
      );
    }
    fireEvent.click(screen.getByRole('button', { name: /Agent à confirmer/ }));
    expect(navigation.navigate).toHaveBeenCalledWith({
      to: '/t/$threadId',
      params: { threadId: 'waiting-agent' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      (screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement)
        .value,
    ).toBe('Brouillon conservé');
  });
