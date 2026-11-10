import { afterEach, expect, test, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { NotificationCenter } from './notification-center';
import { useInboxStore } from './inbox-state';
import { inboxFixture } from './inbox-fixture';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => '/t/first',
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    data: { personId: 'me', kind: 'person', active: true },
  }),
}));
vi.mock('@/lib/session-recovery', () => ({ useSessionPaused: () => false }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useInboxStore.setState({ open: false });
});
test.each([390, 1100])(
  'keeps the header fixed while the notification list scrolls at %ipx',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 750);
    inboxFixture(40);
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <main className="min-h-dvh bg-background p-6 text-foreground">
          Conversation de l’agent
        </main>
        <NotificationCenter />
      </QueryClientProvider>,
    );
    act(() => useInboxStore.setState({ open: true }));
    await screen.findByText('Notification 0');
    const panel = screen.getByRole('region', { name: 'Notifications' }),
      list = screen.getByLabelText('Liste des notifications'),
      header = panel.querySelector('header')!;
    expect(panel.getBoundingClientRect().top).toBe(0);
    expect(panel.getBoundingClientRect().bottom).toBe(window.innerHeight);
    const top = header.getBoundingClientRect().top;
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    list.scrollTop = 600;
    fireEvent.scroll(list);
    expect(header.getBoundingClientRect().top).toBe(top);
    expect(list.scrollTop).toBeGreaterThan(0);
    expect(panel.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/notification-center-scroll-${width}.png`,
    });
    client.clear();
  },
);
