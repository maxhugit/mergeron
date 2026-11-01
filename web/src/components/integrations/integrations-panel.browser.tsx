/** Actual integration components with synthetic transport responses; no account or server changes. */
import { afterEach, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { page } from 'vitest/browser';
import { CodexSettings } from '../settings/codex-settings';
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
const plugin = {
  id: 'docs',
  name: 'Documents',
  source: {},
  installed: true,
  enabled: true,
  installPolicy: 'AVAILABLE',
  authPolicy: 'ON_USE',
  interface: null,
};
const inventory = {
  marketplaces: [
    {
      name: 'openai-curated-remote',
      path: null,
      interface: null,
      plugins: [
        plugin,
        ...Array.from({ length: 29 }, (_, i) => ({
          ...plugin,
          id: `plugin-${i}`,
          name: `Plugin ${i}`,
        })),
      ],
    },
  ],
  marketplaceLoadErrors: [],
  featuredPluginIds: ['docs'],
  remoteSyncError: null,
};

test.each([390, 1280])(
  'keeps inventories, modals and navigation usable at %ipx',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 913);
    document.documentElement.classList.add('dark');
    const calls: string[] = [];
    vi.spyOn(client, 'get').mockImplementation(async (options) => {
      calls.push(options.url);
      if (
        options.url === '/api/plugins/installed' ||
        options.url === '/api/plugins'
      )
        return {
          data: {
            ...inventory,
            featuredPluginIds: options.url.endsWith('/installed')
              ? []
              : ['docs'],
          },
        } as never;
      if (options.url === '/api/plugins/detail') {
        expect(options.query).toEqual({
          remoteMarketplaceName: 'openai-curated-remote',
          pluginName: 'Documents',
        });
        return {
          data: {
            plugin: {
              summary: plugin,
              description: 'Créer et relire des documents.',
              marketplacePath: null,
              marketplaceName: 'openai-curated-remote',
              skills: [],
              mcpServers: [],
              apps: [],
            },
          },
        } as never;
      }
      if (options.url === '/api/apps/installed')
        return {
          data: {
            apps: [
              ...Array.from({ length: 25 }, (_, i) => ({
                id: `app-${i}`,
                runtimeName: `Application ${i}`,
                enabled: true,
                callable: true,
              })),
              {
                id: 'home',
                runtimeName: 'Home Assistant',
                enabled: true,
                callable: true,
              },
            ],
          },
        } as never;
      if (options.url === '/api/apps')
        throw { message: '403 Forbidden', errorCode: 'codex.rpc_error' };
      if (options.url === '/api/mcp-servers')
        return {
          data: {
            data: Array.from({ length: 25 }, (_, i) => ({
              name: `server-${i}`,
              tools: {},
              authStatus: 'unsupported',
            })),
            nextCursor: null,
          },
        } as never;
      if (options.url === '/api/account')
        return { data: { account: null } } as never;
      if (options.url === '/api/settings/{key}')
        return { data: { value: '' } } as never;
      if (options.url === '/api/codex/config')
        return { data: { config: {}, origins: {} } } as never;
      throw Error('Unexpected fixture request: ' + options.url);
    });
    query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={query}>
        <TooltipProvider>
          <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
            <header className="border-b px-4 py-3 text-lg">
              Codex · Intégrations
            </header>
            <div className="flex min-h-0 flex-1 flex-col">
              <CodexSettings initialTab="integrations" />
            </div>
          </main>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await screen.findByText('Documents');
    expect(calls).toContain('/api/plugins/installed');
    expect(calls).not.toContain('/api/plugins');
    const assertInnerScroll = async (section: string) => {
      const list = screen.getByRole('region', {
        name: 'Liste des intégrations',
      });
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
      const tabsTop = screen
        .getByRole('tab', { name: 'Plugins' })
        .getBoundingClientRect().top;
      list.scrollTop = 200;
      await waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
      expect(
        screen.getByRole('tab', { name: 'Plugins' }).getBoundingClientRect()
          .top,
      ).toBe(tabsTop);
      expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(
        window.innerHeight + 1,
      );
      // No intermediate ancestor consumes wheel scrolling or grows past its viewport.
      for (
        let parent = list.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        expect(parent.scrollHeight).toBeLessThanOrEqual(
          parent.clientHeight + 1,
        );
      }
      list.scrollTop = 0;
      await page
        .getByRole('main')
        .screenshot({
          path: `../../../.vitest-screenshots/integrations-list-${section}-${navigator.userAgent.includes('Chrome') ? 'chromium' : 'webkit'}-${width}.png`,
        });
    };
    await assertInnerScroll('plugins');
    const engine = navigator.userAgent.includes('Chrome')
      ? 'chromium'
      : 'webkit';
    await page.getByRole('main').screenshot({
      path: `../../../.vitest-screenshots/integrations-plugins-${engine}-${width}.png`,
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Gérer' })[0]);
    const pluginDialog = await screen.findByRole('dialog');
    expect(pluginDialog).toBeVisible();
    expect(
      await screen.findByText('Créer et relire des documents.'),
    ).toBeVisible();
    await page.getByRole('dialog').screenshot({
      path: `../../../.vitest-screenshots/integrations-plugin-modal-${engine}-${width}.png`,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('tab', { name: 'Applications' }));
    expect(await screen.findByText('Home Assistant')).toBeVisible();
    await assertInnerScroll('apps');
    expect(calls).not.toContain('/api/apps');
    fireEvent.click(screen.getByRole('tab', { name: 'Catalogue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'temporairement indisponible',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('<html>');
    fireEvent.click(screen.getByRole('tab', { name: 'Serveurs MCP' }));
    await screen.findByText('server-0');
    expect(screen.getByText('Mergeron (interne)')).toBeVisible();
    expect(screen.getByText('Par conversation')).toBeVisible();
    await assertInnerScroll('mcps');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Ajouter un serveur' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Ajouter un serveur',
    });
    expect(dialog).toBeVisible();
    expect(dialog.getBoundingClientRect().width).toBeLessThan(width);
    expect(dialog.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    await page.getByRole('dialog').screenshot({
      path: `../../../.vitest-screenshots/integrations-mcp-form-${engine}-${width}.png`,
    });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);
