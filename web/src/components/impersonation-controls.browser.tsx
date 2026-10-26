import { afterEach, expect, test, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { page } from 'vitest/browser';
import { ImpersonationBanner } from './impersonation-controls';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const state = vi.hoisted(() => ({ expired: false }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    data: {
      impersonation: {
        administratorName: 'Maxime HUGOT',
        personName: 'Une personne avec un nom très long pour tester les droits',
        expiresAt: Date.now() + 900000,
        expired: state.expired,
      },
    },
  }),
}));
afterEach(cleanup);
test.each([390, 1001])(
  'keeps the permanent identity banner and exit accessible at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    state.expired = false;
    render(
      <div className="flex h-dvh flex-col">
        <ImpersonationBanner />
        <main className="min-h-0 flex-1 overflow-auto">
          Contenu de la plateforme
        </main>
      </div>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Maxime HUGOT');
    expect(
      screen.getByRole('button', { name: 'Revenir à mon compte' }),
    ).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);
test('keeps the escape visible when the target workspace is no longer accessible', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  state.expired = true;
  render(<ImpersonationBanner />);
  expect(screen.getByRole('status')).toHaveTextContent('n’est plus valide');
  expect(
    screen.getByRole('button', { name: 'Revenir à mon compte' }),
  ).toBeVisible();
});
