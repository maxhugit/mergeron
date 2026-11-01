/** Real CLI settings with synthetic metadata only; never installs a CLI. */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { catalogFixture, json } from './catalog/catalog.testing';
import { CodexCliSettings } from './codex-cli-settings';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test.each([390, 1100])(
  'explains a managed CLI adoption refusal without overflow at %ipx',
  async (width) => {
    await i18nReady;
    const fixture = catalogFixture();
    await i18n.changeLanguage('fr');
    await page.viewport(width, 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, options?: RequestInit) => {
        expect(options?.method ?? 'GET').toBe('GET');
        return Promise.resolve(
          json({
            installedVersion: '0.162.1',
            selectedVersion: null,
            installationState: 'legacy',
            latestVersion: null,
            updateAvailable: false,
            canManage: true,
            canRollback: false,
            busy: false,
            officialUpdateBlocked: true,
            installedError: 'codexRuntimeApplicationNotManaged',
            managedRelease: {
              id: '0.164.0-mergeron.1',
              upstreamVersion: '0.164.0',
              upstreamCommit: 'a'.repeat(40),
              patchSha256: 'b'.repeat(64),
              manifestSha256: 'c'.repeat(64),
            },
          }),
        );
      }),
    );
    fixture.render(
      <main className="min-h-dvh bg-background p-4 text-foreground">
        <CodexCliSettings />
      </main>,
    );
    try {
      const error = await screen.findByRole('alert');
      expect(error.textContent).toContain(
        'vérifiez son adoption dans Infrastructure',
      );
      expect(
        screen.queryByText('codexRuntimeApplicationNotManaged'),
      ).toBeNull();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/codex-cli-adoption-${width}.png`,
      });
    } finally {
      fixture.dispose();
    }
  },
);
