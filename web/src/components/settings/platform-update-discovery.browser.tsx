/** Real settings components, synthetic metadata only; never installs an image. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { InstalledImageChanges } from './installed-image-changes';
import { ManagerImageUpdates } from './manager-image-updates';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test.each([1100, 390])(
  'separates installed improvements and verified component updates at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const revision = 'a'.repeat(40);
    const digest = `sha256:${'b'.repeat(64)}`;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        void options;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              String(input).includes('installed-changes')
                ? {
                    revision,
                    items: [
                      'Corrige les fausses alertes liées au catalogue multi-plateforme.',
                    ],
                    checkError: null,
                  }
                : {
                    components: [
                      {
                        id: 'ingress',
                        displayName: 'Nginx',
                        installedImage: `nginx@${digest}`,
                        targetImage: 'nginx:stable',
                        targetDigest: digest,
                        versionStatus: 'current',
                        updateAvailable: false,
                        checkError: null,
                        notesUrl: 'https://nginx.org/en/CHANGES',
                      },
                      {
                        id: 'browser',
                        displayName: 'Navigateur Mergeron',
                        targetImage: 'ghcr.io/maxhugit/mergeron-browser:edge',
                        targetDigest: digest,
                        versionStatus: 'update_available',
                        updateAvailable: true,
                        checkError: null,
                      },
                      {
                        id: 'egress',
                        displayName: 'Squid',
                        targetImage: 'ubuntu/squid:latest',
                        targetDigest: digest,
                        versionStatus: 'unknown',
                        updateAvailable: false,
                        checkError: 'platformIdentityUnavailable',
                      },
                    ],
                  },
            ),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const update = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <main className="min-h-screen bg-background p-4 text-foreground">
          <h1 className="mb-4 text-xl font-semibold">
            Serveur — Versions et améliorations
          </h1>
          <InstalledImageChanges revision={revision} enabled />
          <div className="mt-6">
            <ManagerImageUpdates disabled={false} onUpdate={update} />
          </div>
        </main>
      </QueryClientProvider>,
    );
    try {
      expect(
        await screen.findByText(
          'Corrige les fausses alertes liées au catalogue multi-plateforme.',
        ),
      ).toBeVisible();
      expect(
        await screen.findByRole('button', { name: 'Mettre à jour Nginx…' }),
      ).toBeDisabled();
      expect(
        screen.getByRole('button', {
          name: 'Mettre à jour Navigateur Mergeron…',
        }),
      ).toBeEnabled();
      expect(
        screen.getByRole('button', { name: 'Mettre à jour Squid…' }),
      ).toBeDisabled();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      expect(
        fetchMock.mock.calls.every(
          ([, options]) => !options?.method || options.method === 'GET',
        ),
      ).toBe(true);
      expect(update).not.toHaveBeenCalled();
      await page.screenshot({
        path: `../../../.vitest-screenshots/platform-updates-${width}.png`,
      });
    } finally {
      client.clear();
    }
  },
);
