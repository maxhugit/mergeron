/** Layout-only fixtures: no live server update or backup operations. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { page } from 'vitest/browser';
import { SettingsPage } from './settings-page';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { search: { section: 'general' } } }),
}));
vi.mock('./use-category-settings', () => ({
  useCategorySettings: () => ({
    settings: [],
    drafts: {},
    isDirty: false,
    isLoading: false,
  }),
}));
vi.mock('./server-version-card', () => ({
  ServerVersionCard: () => (
    <section className="rounded-xl border p-4">Version de Mergeron</section>
  ),
}));
afterEach(cleanup);
test.each([390, 1100])(
  'places the Server tab strip immediately below the header, full width at %ipx',
  async (width) => {
    await page.viewport(width, 800);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const view = render(
      <div className="flex h-[700px] w-full flex-col">
        <SettingsPage />
      </div>,
    );
    await expect.poll(() => screen.queryByRole('tablist')).not.toBeNull();
    const tabs = screen.getByRole('tablist');
    const bounds = tabs.getBoundingClientRect();
    const parent = view.container.firstElementChild!.getBoundingClientRect();
    expect(bounds.width).toBe(parent.width);
    expect(Math.abs(bounds.top - parent.top)).toBeLessThanOrEqual(1);
    expect(tabs.parentElement!.getBoundingClientRect().height).toBe(40);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/server-tabs-${width}.png`,
    });
  },
);
