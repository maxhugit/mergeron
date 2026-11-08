import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { page } from 'vitest/browser';
import { HelpRoute } from './help-route';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});
test.each([
  [390, 'fr'],
  [1280, 'en'],
] as const)(
  'renders a scrollable vertical version history at %ipx in %s',
  async (width, language) => {
    await i18nReady;
    await i18n.changeLanguage(language);
    await page.viewport(width, 913);
    window.history.replaceState(null, '', '/help#guide/version-history');
    render(
      <div className="flex h-screen min-h-0">
        <HelpRoute />
      </div>,
    );
    const article = screen.getByRole('article');
    const timeline = within(article).getByRole('list', {
      name:
        language === 'fr'
          ? 'Frise des versions publiées'
          : 'Published release timeline',
    });
    const headings = within(timeline).getAllByRole('heading');
    expect(headings).toHaveLength(15);
    expect(headings[1].getBoundingClientRect().top).toBeGreaterThan(
      headings[0].getBoundingClientRect().top,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth);
    headings[0].scrollIntoView({ block: 'start' });
    await page
      .getByRole('main')
      .screenshot({ path: `.vitest-screenshots/version-history-${width}.png` });
    const oldest = within(timeline).getByRole('link', { name: /v0.1.0/ });
    oldest.scrollIntoView({ block: 'center' });
    expect(oldest).toBeVisible();
    expect(article.scrollTop).toBeGreaterThan(0);
    expect(oldest).toHaveAttribute(
      'href',
      'https://github.com/maxhugit/mergeron/releases/tag/v0.1.0',
    );
    oldest.focus();
    expect(oldest).toHaveFocus();
  },
);
