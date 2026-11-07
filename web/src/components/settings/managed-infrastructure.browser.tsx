import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { ManagerStatusCard } from './manager-status-card';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
for (const width of [390, 1280])
  test(`discovered infrastructure at ${width}px`, async () => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 1000);
    const status = {
      available: true,
      mode: 'observe',
      dockerConnected: true,
      components: [
        'mergeron-dev-acces-web-1',
        'mergeron-dev-acces-web-2',
        'nouveau-service',
      ].map((name, i) => ({
        id: `container:role:${i}`,
        discovered: true,
        observational: true,
        role: i < 2 ? 'updateGateway' : 'futureWorker',
        displayName: name,
        containerName: name,
        state: 'healthy',
        adoption: 'managed',
        imageRepositoryAllowed: null,
        networks: ['proxy'],
        missingNetworks: [],
        protectedMounts: [],
        restartCount: 0,
      })),
      dataSafety: { status: 'protected', blockers: [], protectedMounts: [] },
      adoption: { state: 'eligible', canAdopt: false, blockers: [] },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(status), {
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <main className="mx-auto max-w-5xl p-4">
          <ManagerStatusCard />
        </main>
      </QueryClientProvider>,
    );
    await screen.findAllByText('mergeron-dev-acces-web-1');
    expect(screen.getAllByText('nouveau-service')[0]).toBeTruthy();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/managed-infrastructure-${width}.png`,
    });
  });
