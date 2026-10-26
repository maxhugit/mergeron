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

test('keeps update actions below the scroller on desktop and mobile, without covering content', async () => {
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
  fireEvent.click(screen.getByRole('tab', { name: 'Update' }));
  const update = await screen.findByRole('button', {
    name: 'Update',
  });
  const footer = update.parentElement!;
  for (const width of [1100, 390]) {
    await page.viewport(width, 700);
    await expect
      .poll(() =>
        Math.round(footer.parentElement!.getBoundingClientRect().bottom),
      )
      .toBe(700);
    for (const label of [
      'Refresh detection',
      'View progress and logs',
      'Restore previous version',
    ]) {
      const button = screen.getByRole('button', { name: label });
      expect(button.parentElement).toBe(footer);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(
      screen.getByLabelText('Target application image (tag or digest)'),
    ).toBeVisible();
  }
  fireEvent.click(screen.getByRole('tab', { name: 'Current version' }));
  expect(update).not.toBeVisible();
  fixture.dispose();
});
