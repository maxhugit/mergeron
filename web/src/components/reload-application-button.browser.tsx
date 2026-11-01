import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { page } from 'vitest/browser';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ReloadApplicationButton } from './reload-application-button';
import { prepareApplicationReload } from '@/lib/reload-application';
import { useComposerDraftStore } from '@/stores/composer-draft-store';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

vi.mock('@/lib/reload-application', async (original) => ({
  ...(await original<typeof import('@/lib/reload-application')>()),
  // Prevent test-page navigation only; CacheStorage below is the real browser API.
  reloadApplication: () => new Promise(() => {}),
}));
afterEach(cleanup);

test.each([390, 1180])(
  'keeps the refresh control aligned and disabled during cleanup at %ipx',
  async (width) => {
    await page.viewport(width, 600);
    await i18nReady;
    await i18n.changeLanguage('fr');
    useComposerDraftStore.setState({ drafts: {} });
    render(
      <TooltipProvider>
        <header className="flex h-12 items-center justify-between bg-card px-4 text-foreground">
          <span>Mergeron</span>
          <ReloadApplicationButton />
        </header>
      </TooltipProvider>,
    );
    const button = screen.getByRole('button', {
      name: 'Rafraîchir l’application',
    });
    expect(button).toBeVisible();
    expect(button.getBoundingClientRect().height).toBe(32);
    await page
      .getByRole('button', { name: 'Rafraîchir l’application' })
      .click();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../.vitest-screenshots/reload-${width}.png`,
    });
  },
);

test('cleans real browser caches without touching other caches, preferences or cookies', async () => {
  const owned = 'mergeron-static-reload-test';
  const other = 'unrelated-reload-test';
  localStorage.setItem('reload-test-preference', 'kept');
  document.cookie = 'reload-test-session=kept; SameSite=Strict; path=/';
  try {
    for (const name of [owned, other]) {
      const cache = await caches.open(name);
      await cache.put('/reload-test-asset.js', new Response('fixture'));
    }
    await prepareApplicationReload();
    expect(await caches.has(owned)).toBe(false);
    expect(await caches.has(other)).toBe(true);
    expect(localStorage.getItem('reload-test-preference')).toBe('kept');
    expect(document.cookie).toContain('reload-test-session=kept');
  } finally {
    await caches.delete(owned);
    await caches.delete(other);
    localStorage.removeItem('reload-test-preference');
    document.cookie = 'reload-test-session=; Max-Age=0; path=/';
  }
});
