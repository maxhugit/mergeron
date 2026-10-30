/** UI fixtures only: no browser permission prompt or real Push service call. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { PushNotificationSettings } from './push-notification-settings';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    data: {
      kind: 'person',
      personId: 'p',
      active: true,
      role: 'administrator',
    },
  }),
}));
vi.mock('@/lib/push-notifications', () => ({
  readPushStatus: async () => ({
    configured: true,
    publicKey: 'key',
    devices: [
      {
        id: 'd',
        label: 'iPhone personnel',
        completed: true,
        approvals: true,
        questions: true,
        lastTestStatus: 'sent',
      },
    ],
  }),
  browserPushEnabled: async () => true,
  currentPushDevice: () => ({ id: 'd', personId: 'p' }),
  pushSupported: () => true,
  enablePush: vi.fn(),
  revokePushDevice: vi.fn(),
  testPushDevice: vi.fn(),
  unsubscribeBrowserPush: vi.fn(),
  updatePushDevice: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test.each([1000, 390])(
  'shows notification preferences without overflow at %ipx',
  async (width) => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <div className="min-h-screen bg-background p-4 text-foreground">
          <PushNotificationSettings />
        </div>
      </QueryClientProvider>,
    );
    try {
      expect(
        await screen.findByText('iPhone personnel — cet appareil'),
      ).toBeVisible();
      expect(
        screen.getByRole('checkbox', { name: 'Réponse terminée' }),
      ).toBeChecked();
      expect(
        screen.getByRole('button', { name: 'Envoyer un test' }),
      ).toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/push-preferences-${width}.png`,
      });
    } finally {
      client.clear();
    }
  },
);
