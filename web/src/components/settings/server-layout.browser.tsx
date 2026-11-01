import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { GeneralSettings } from './general-settings';
import { catalogFixture, json } from './catalog/catalog.testing';
import { managerStatusQueryKey } from './manager-status-api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('keeps update actions below the table and reachable inside the scroller on desktop and mobile', async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
  const fixture = catalogFixture();
  fixture.queryClient.setQueryData(managerStatusQueryKey, {
    available: true,
    components: [],
    update: {
      busy: false,
      operation: {
        id: 'finished',
        status: 'succeeded',
        phase: 'complete',
        backupRetained: true,
        images: {},
        previousImages: {},
        events: [],
      },
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        json({
          installed: { version: '1.0', channel: 'edge', revision: 'test' },
          latestVersion: '1.0',
          versionStatus: 'current',
          updateAvailable: false,
          targetImage: 'ghcr.io/maxhugit/mergeron:edge',
          checkedAt: '2026-10-26T12:00:00Z',
          releases: [],
        }),
      ),
    ),
  );
  fixture.render(
    <div className="flex h-dvh min-h-0 flex-col">
      <GeneralSettings />
    </div>,
  );
  await screen.findAllByText('1.0');
  fireEvent.click(screen.getByRole('tab', { name: 'Current version' }));
  const refresh = await screen.findByRole('button', {
    name: 'Refresh detection',
  });
  const footer = refresh.parentElement!;
  const table = screen.getByRole('table');
  for (const width of [1100, 390]) {
    await page.viewport(width, 700);
    const update = screen.getByRole('button', { name: /Update selected/ });
    expect(update.parentElement).toBe(footer);
    expect(update).toBeDisabled();
    expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      table.getBoundingClientRect().bottom,
    );
    refresh.scrollIntoView({ block: 'center' });
    await expect
      .poll(() => Math.ceil(refresh.getBoundingClientRect().bottom))
      .toBeLessThanOrEqual(700);
    expect(refresh.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/server-actions-${width}.png`,
    });
  }
  fireEvent.click(screen.getByRole('tab', { name: 'Update history' }));
  expect(refresh).not.toBeVisible();
  fixture.dispose();
});
