import { useTimelineStore } from '@/stores/timeline-store';
/** Conversation-scoped MCP inventory, rendered with actual translated popovers. */
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { McpStatusBadge } from './mcp-status-badge';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
vi.mock('@/hooks/use-current-project', () => ({
  useCurrentProject: () => ({ id: 'project', mcpServerIds: [] }),
}));
vi.mock('@/generated/api/sdk.gen', async (original) => ({
  ...(await original<typeof import('@/generated/api/sdk.gen')>()),
  mcpServersListServers: async ({
    query,
  }: {
    query: { threadId: string };
  }) => ({
    data: {
      data:
        query.threadId === 'ready-agent'
          ? [
              {
                name: 'mergeron_internal',
                tools: { project_get: {} },
                authStatus: 'unsupported',
              },
            ]
          : [],
    },
  }),
  mcpServersReloadAll: vi.fn(),
}));
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});
test.each([390, 980])(
  'shows observed internal tools and an honest unobserved state at %ipx',
  async (width) => {
    await page.viewport(width, 913);
    await i18nReady;
    await i18n.changeLanguage('fr');
    document.documentElement.classList.add('dark');
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (threadId: string) => (
      <QueryClientProvider client={client}>
        <main className="flex h-[850px] items-end bg-background p-4 text-foreground">
          <McpStatusBadge threadId={threadId} menuItem />
        </main>
      </QueryClientProvider>
    );
    useTimelineStore.getState().ensureThreadState({ threadId: 'ready-agent' });
    useTimelineStore
      .getState()
      .setOpenStateForThread('ready-agent', { openState: 'ready' });
    useTimelineStore.getState().ensureThreadState({ threadId: 'new-agent' });
    useTimelineStore
      .getState()
      .setOpenStateForThread('new-agent', { openState: 'ready' });
    const view = render(tree('ready-agent'));
    try {
      await page.getByRole('button', { name: /Serveurs MCP · 1/ }).click();
      await expect.element(page.getByText('Mergeron (interne)')).toBeVisible();
      const panel = screen.getByRole('dialog').getBoundingClientRect();
      expect(panel.left).toBeGreaterThanOrEqual(0);
      expect(panel.right).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/mcp-internal-${navigator.userAgent.includes('Chrome') ? 'chromium' : 'webkit'}-${width}.png`,
      });
      view.rerender(tree('new-agent'));
      await expect
        .element(page.getByText('Non observé', { exact: true }))
        .toBeVisible();
      expect(
        screen.getByRole('button', { name: 'Recharger tout' }),
      ).toBeDisabled();
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
