import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { ServerCapabilities } from './server-capabilities';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
for (const width of [390, 1280])
  test(`capability catalogue and confirmation at ${width}px`, async () => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 900);
    const fetcher = vi
      .fn<(url?: string, options?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            operation: null,
            error: null,
            capabilities: [
              {
                id: 'browser',
                installed: false,
                state: 'notInstalled',
                activeLeases: 0,
              },
              {
                id: 'transcription',
                installed: true,
                state: 'stopped',
                activeLeases: 0,
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );
    // A fresh Response per poll, as with a real HTTP request.
    const body = await (await fetcher()).text();
    fetcher.mockImplementation(
      async () =>
        new Response(body, { headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <main className="mx-auto max-w-5xl p-4">
          <ServerCapabilities />
        </main>
      </QueryClientProvider>,
    );
    await screen.findByText('Navigation web');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/server-capabilities-${width}.png`,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Désinstaller' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/transcriptions déjà produites/)).toBeTruthy();
    expect(fetcher.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false);
  });
