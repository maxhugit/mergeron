/** Reproducible user-guide captures: real controls, synthetic data, no live API. */
import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { page } from 'vitest/browser';
import { TaskManagerToolbar } from '@/components/projects/task-manager-toolbar';
import { DeliverableLifecycleFlow } from '@/components/projects/project-deliverables-manager';
import type { Deliverable } from '@/lib/deliverables-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { HelpRoute } from './help-route';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  document.documentElement.classList.remove('dark');
});

test.each([390, 1100])(
  'keeps searchable guide header fixed while articles scroll at %ipx',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 900);
    document.documentElement.classList.add('dark');
    window.history.replaceState(null, '', '/help#guide/task-board');
    render(
      <div style={{ display: 'flex', height: 720, minHeight: 0 }}>
        <HelpRoute />
      </div>,
    );
    const strip = screen.getByRole('search');
    const panel = screen.getByRole('article');
    const top = strip.getBoundingClientRect().top;
    panel.scrollTop = 300;
    expect(panel.scrollTop).toBeGreaterThan(0);
    expect(strip.getBoundingClientRect().top).toBe(top);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    if (width < 768)
      fireEvent.click(screen.getByRole('button', { name: 'Sommaire' }));
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'passkey' },
    });
    expect(
      screen.getByRole('link', { name: /Naviguer dans une page en direct/ }),
    ).toBeVisible();
    if (width === 1100)
      await page
        .getByRole('main')
        .screenshot({
          path: '../../.vitest-screenshots/guide-search-1100.png',
        });
    fireEvent.click(
      screen.getByRole('link', { name: /Naviguer dans une page en direct/ }),
    );
    expect(panel).toHaveAccessibleName('Naviguer dans une page en direct');
    fireEvent.click(
      screen.getByRole('button', { name: 'Effacer la recherche' }),
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.getByRole('main').screenshot({
      path: `../../.vitest-screenshots/guide-manual-${width}.png`,
    });
  },
);
test.skipIf(import.meta.env.VITE_CAPTURE_GUIDE !== '1').each(['fr', 'en'])(
  'captures localized guide controls (%s)',
  async (language) => {
    await i18nReady;
    await i18n.changeLanguage(language);
    await page.viewport(1100, 260);
    document.documentElement.classList.add('dark');
    const toolbar = render(
      <div data-testid="guide-capture" style={{ padding: 20 }}>
        <TaskManagerToolbar
          view="board"
          onViewChange={() => {}}
          panelId="guide-tasks"
          onPlan={() => {}}
          onNewTask={() => {}}
          onSettings={() => {}}
        />
      </div>,
    );
    await page
      .getByTestId('guide-capture')
      .screenshot({ path: `../../public/guide/tasks-${language}.png` });
    toolbar.unmount();
    render(
      <div data-testid="guide-capture" style={{ padding: 20 }}>
        <DeliverableLifecycleFlow
          item={
            {
              lifecycleStatus: 'in_constitution',
              validationRequired: true,
              validationStatus: 'pending',
            } as Deliverable
          }
        />
      </div>,
    );
    await page
      .getByTestId('guide-capture')
      .screenshot({ path: `../../public/guide/deliverables-${language}.png` });
  },
);
