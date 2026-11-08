/** Real CLI settings with synthetic metadata only; never installs a CLI. */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { catalogFixture, deferred, json } from './catalog/catalog.testing';
import { CodexCliSettings } from './codex-cli-settings';
import { AccountLoginDialog } from './account/account-login-dialog';
import { useAccountStore } from '@/stores/account-store';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAccountStore.getState().clearLogin();
});

test.each([390, 1157])(
  'shows installation progress until the real request settles at %ipx',
  async (width) => {
    await i18nReady;
    const fixture = catalogFixture();
    const response = deferred<Response>();
    await i18n.changeLanguage('fr');
    await page.viewport(width, 913);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, options?: RequestInit) =>
        options?.method === 'POST'
          ? response.promise
          : Promise.resolve(
              json({
                installedVersion: null,
                selectedVersion: null,
                installationState: 'missing',
                latestVersion: null,
                updateAvailable: false,
                canManage: true,
                canRollback: false,
                busy: false,
                officialUpdateBlocked: true,
                managedRelease: {
                  id: '0.164.0-mergeron.1',
                  upstreamVersion: '0.164.0',
                  upstreamCommit: 'a'.repeat(40),
                  patchSha256: 'b'.repeat(64),
                  manifestSha256: 'c'.repeat(64),
                },
              }),
            ),
      ),
    );
    fixture.render(<CodexCliSettings />);
    try {
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole('button', {
          name: 'Installer le CLI validé du Manager',
        }),
      );
      await user.click(screen.getByRole('button', { name: 'Confirmer' }));
      const dialog = await screen.findByRole('alertdialog', {
        name: 'Installation ou modification du CLI en cours…',
      });
      await user.keyboard('{Escape}');
      expect(dialog).toBeVisible();
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
      expect(dialog.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/codex-install-progress-${width}.png`,
      });
      response.resolve(json({ success: true }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    } finally {
      response.resolve(json({ success: true }));
      fixture.dispose();
    }
  },
);

test.each([390, 1157])(
  'keeps the French device login contents and actions inside the dialog at %ipx',
  async (width) => {
    await i18nReady;
    const fixture = catalogFixture();
    await i18n.changeLanguage('fr');
    await page.viewport(width, 913);
    fixture.server.overrides.set('POST /api/account/login', () =>
      Promise.resolve(
        json({
          type: 'chatgptDeviceCode',
          loginId: 'synthetic-login',
          userCode: '1234-TEST',
          verificationUrl: 'https://auth.openai.com/codex/device',
        }),
      ),
    );
    fixture.render(
      <AccountLoginDialog open onOpenChange={() => {}} onChanged={() => {}} />,
    );
    try {
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole('button', {
          name: "Démarrer la connexion par code d'appareil",
        }),
      );
      await screen.findByText('1234-TEST');
      const dialog = screen.getByRole('dialog');
      const bounds = dialog.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(width);
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
      for (const item of dialog.querySelectorAll(
        'button, a, [data-slot="dialog-description"]',
      )) {
        const rect = item.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
        expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
      }
      await page.screenshot({
        path: `../../../.vitest-screenshots/codex-login-fit-${width}.png`,
      });
    } finally {
      fixture.dispose();
    }
  },
);
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
