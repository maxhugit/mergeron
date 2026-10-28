import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { GitInspectionError } from './git-inspection-error';

afterEach(cleanup);

test.each(['fr', 'en'])(
  'keeps detailed Git refusal messages readable on desktop/mobile in %s',
  async (language) => {
    await i18nReady;
    await i18n.changeLanguage(language);
    document.documentElement.classList.add('dark');
    render(
      <main className="min-h-dvh bg-background p-4 text-foreground">
        <aside className="ml-auto w-full max-w-md space-y-4 rounded-lg border p-3">
          <h1 className="text-sm">Git Mergeron</h1>
          <GitInspectionError error={new Error('GIT_OUTPUT_LIMIT_EXCEEDED')} />
          <GitInspectionError error={new Error('GIT_COMMAND_TIMEOUT')} />
        </aside>
      </main>,
    );
    for (const width of [1440, 390]) {
      await page.viewport(width, 900);
      expect(screen.getAllByRole('alert')).toHaveLength(2);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      for (const alert of screen.getAllByRole('alert')) {
        expect(alert).toBeVisible();
        expect(alert.getBoundingClientRect().right).toBeLessThanOrEqual(width);
        expect(alert.scrollWidth).toBeLessThanOrEqual(alert.clientWidth);
      }
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-inspection-${language}-${width}.png`,
      });
    }
  },
);
