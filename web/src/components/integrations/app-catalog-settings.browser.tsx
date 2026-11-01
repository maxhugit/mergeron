import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { IntegrationsPanel } from './integrations-panel';
import { TooltipProvider } from '@/components/ui/tooltip';
import { client } from '@/generated/api/client.gen';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
let query: QueryClient;
afterEach(() => {
  cleanup();
  query?.clear();
  vi.restoreAllMocks();
  document.documentElement.classList.remove('dark');
});
test.each([390, 1280])(
  'shows the failed refresh, preserved local catalog and scrollable journal at %ipx',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 913);
    document.documentElement.classList.add('dark');
    const post = vi.spyOn(client, 'post');
    vi.spyOn(client, 'get').mockImplementation(async (options) => {
      if (options.url === '/api/apps/installed')
        return { data: { apps: [] } } as never;
      if (options.url === '/api/apps/catalog/status')
        return {
          data: {
            source: 'byparr',
            worker: {
              enabled: true,
              present: true,
              running: true,
              healthy: true,
              version: '3.0.4',
              error: null,
            },
            running: false,
            updatedAt: 1793534400000,
            nextAttempt: 1793620800000,
            count: 5011,
            warning: true,
            stale: false,
            history: Array.from({ length: 30 }, (_, index) => ({
              at: 1793534400000 - index * 86400000,
              status: index === 0 ? 'failed' : 'success',
              code: index === 0 ? 'CATALOG_DOWNLOAD_FAILED' : 'CATALOG_UPDATED',
              count: index === 0 ? undefined : 5011,
            })),
          },
        } as never;
      if (options.url === '/api/apps')
        return {
          data: {
            data: [
              {
                id: 'github',
                pluginDisplayNames: [],
                name: 'GitHub',
                description: 'Explorer les dépôts et les demandes de fusion.',
                logoUrl: null,
                logoUrlDark: null,
                branding: null,
                distributionChannel: null,
                appMetadata: null,
                labels: null,
                installUrl: 'https://chatgpt.com/apps/github/github',
                isAccessible: false,
                isEnabled: false,
              },
            ],
            nextCursor: null,
          },
        } as never;
      throw Error('Unexpected fixture request: ' + options.url);
    });
    query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={query}>
        <TooltipProvider>
          <main className="flex h-screen min-h-0 flex-col bg-background p-3 text-foreground">
            <header className="shrink-0 py-3 text-lg">
              Codex · Intégrations
            </header>
            <IntegrationsPanel initialSection="apps" />
          </main>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Catalogue' }));
    expect(await screen.findByText('GitHub')).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le dernier catalogue valide',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Journal du catalogue' }),
    );
    const journal = await screen.findByRole('region', {
      name: 'Journal du catalogue',
    });
    expect(within(journal).getAllByRole('row')).toHaveLength(31);
    expect(journal.clientHeight).toBeLessThanOrEqual(224);
    expect(journal.scrollHeight).toBeGreaterThan(journal.clientHeight);
    expect(
      getComputedStyle(within(journal).getAllByRole('rowgroup')[0]).position,
    ).toBe('sticky');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(post).not.toHaveBeenCalled();
    const engine = navigator.userAgent.includes('Chrome')
      ? 'chromium'
      : 'webkit';
    await page.getByRole('main').screenshot({
      path: `../../../.vitest-screenshots/daily-catalog-journal-${engine}-${width}.png`,
    });
  },
);
