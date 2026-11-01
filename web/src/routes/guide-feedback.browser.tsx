/** Real guide, sample content only; no GitHub navigation or issue submission. */
import { afterEach, expect, test } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { page } from 'vitest/browser';
import { HelpRoute } from './help-route';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  document.documentElement.classList.remove('dark');
});

test.each([
  [390, 'fr'],
  [1280, 'fr'],
  [390, 'en'],
  [1280, 'en'],
] as const)(
  'keeps the introduction and direct feedback links usable at %ipx in %s',
  async (width, language) => {
    await i18nReady;
    await i18n.changeLanguage(language);
    await page.viewport(width, 913);
    document.documentElement.classList.add('dark');
    window.history.replaceState(null, '', '/help');
    render(
      <div className="flex h-screen min-h-0">
        <HelpRoute />
      </div>,
    );
    const article = screen.getByRole('article');
    const engine = navigator.userAgent.includes('Chrome')
      ? 'chromium'
      : 'webkit';
    const capture = async (name: string) =>
      page
        .getByRole('main')
        .screenshot({
          path: `../../.vitest-screenshots/guide-${name}-${language}-${engine}-${width}.png`,
        });
    expect(article).toHaveTextContent(
      language === 'fr' ? 'plateforme auto-hébergée' : 'self-hosted platform',
    );
    await capture('introduction');
    const project = within(article).getByRole('link', {
      name:
        language === 'fr'
          ? /Projet Mergeron sur GitHub/
          : /Mergeron project on GitHub/,
    });
    project.scrollIntoView({ block: 'center' });
    expect(project).toBeVisible();
    expect(project).toHaveAttribute('target', '_blank');

    for (const [id, template] of [
      ['report-bug', 'bug_report.yml'],
      ['request-improvement', 'feature_request.yml'],
    ]) {
      act(() => {
        window.history.replaceState(null, '', `/help#guide/${id}`);
        fireEvent.popState(window);
      });
      const link = article.querySelector<HTMLAnchorElement>(
        `a[href$="template=${template}"]`,
      )!;
      expect(link).not.toBeNull();
      link.scrollIntoView({ block: 'center' });
      expect(link).toBeVisible();
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link.getBoundingClientRect().width).toBeGreaterThan(200);
      expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth);
      expect(link.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
      expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      link.focus();
      expect(link).toHaveFocus();
      expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await capture(id);
    }
  },
);
