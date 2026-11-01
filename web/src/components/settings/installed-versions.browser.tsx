/** Actual settings view, synthetic registry/inventory only; never updates a service. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
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
test('separates installed builds, registry image and GitHub release on desktop and mobile', async () => {
  await i18nReady;
  const fixture = catalogFixture();
  await i18n.changeLanguage('fr');
  const build = {
    version: '0.5.1',
    channel: 'edge',
    revision: 'a'.repeat(40),
    builtAt: '2026-10-31T12:00:00Z',
  };
  fixture.queryClient.setQueryData(managerStatusQueryKey, {
    available: true,
    observedAt: '2026-10-31T13:00:00Z',
    manager: { build: { ...build, revision: 'b'.repeat(40) } },
    components: [
      {
        id: 'browser',
        build: {
          ...build,
          version: null,
          channel: 'unknown',
          revision: 'c'.repeat(40),
        },
      },
    ],
  });
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET');
    if (String(input).includes('/manager/image-updates'))
      return Promise.resolve(
        json({
          checkedAt: '2026-10-31T13:00:00Z',
          components: [
            {
              id: 'application',
              displayName: 'Mergeron',
              targetImage: 'ghcr.io/maxhugit/mergeron:edge',
              targetDigest: `sha256:${'d'.repeat(64)}`,
              targetBuild: { ...build, revision: 'd'.repeat(40) },
              updateAvailable: true,
              versionStatus: 'update_available',
              checkError: null,
            },
          ],
        }),
      );
    if (!String(input).includes('/release/status'))
      return Promise.resolve(json({}));
    return Promise.resolve(
      json({
        installed: build,
        latestVersion: '0.5.1',
        latestRevision: 'd'.repeat(40),
        latestUrl: `https://github.com/maxhugit/mergeron/commit/${'d'.repeat(40)}`,
        targetImage: 'ghcr.io/maxhugit/mergeron:edge',
        githubRelease: {
          version: '0.5.0',
          url: 'https://github.com/maxhugit/mergeron/releases/tag/v0.5.0',
        },
        versionStatus: 'update_available',
        updateAvailable: true,
        releases: [],
        checkedAt: '2026-10-31T13:00:00Z',
      }),
    );
  });
  vi.stubGlobal('fetch', fetcher);
  fixture.render(
    <div className="flex h-dvh min-h-0 flex-col">
      <GeneralSettings />
    </div>,
  );
  try {
    await screen.findByRole('table');
    for (const width of [1200, 390]) {
      await page.viewport(width, 900);
      fireEvent.click(screen.getByRole('tab', { name: 'Version actuelle' }));
      const rows = within(screen.getByRole('table')).getAllByRole('row');
      expect(within(rows[1]).getByText('aaaaaaa')).toBeVisible();
      expect(within(rows[2]).getByText('bbbbbbb')).toBeVisible();
      expect(within(rows[3]).queryByText('24.04')).toBeNull();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/versions-installed-${width}.png`,
      });
      // The candidate now shares the current-version table with the installed build.
      expect(within(rows[1]).getByText('ddddddd')).toBeVisible();
      expect(within(rows[1]).queryByText('0.5.0')).toBeNull();
      expect(within(rows[1]).getByText('aaaaaaa')).toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/versions-available-${width}.png`,
      });
    }
  } finally {
    fixture.dispose();
  }
});
