/** Backup choice layout with local fixtures, never a real update request. */
import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { client as apiClient } from '@/generated/api/client.gen';
import { updateBackupModeKey } from './use-update-backup-mode';
import { ManagerUpdateControls } from './manager-update-controls';
import type { ManagerStatus } from './manager-status-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

vi.mock('./server-release-api', async (original) => ({
  ...(await original<typeof import('./server-release-api')>()),
  requestServerRelease: async () => ({
    installed: {
      version: '0.5.1',
      revision: null,
      builtAt: null,
      channel: 'edge',
    },
    targetImage: 'ghcr.io/maxhugit/mergeron:edge',
    updateAvailable: false,
    releases: [],
  }),
}));
vi.mock('./manager-image-updates', () => ({ ManagerImageUpdates: () => null }));
const previousClient = apiClient.getConfig();
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  apiClient.setConfig(previousClient);
});

test.each([1000, 390])(
  'shows all three backup scopes without overflow at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    let saved = 'full';
    const writes: string[] = [];
    apiClient.setConfig({
      baseUrl: window.location.origin,
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        if (
          new URL(request.url).pathname !==
          `/api/settings/${updateBackupModeKey}`
        )
          throw new Error('Unexpected fixture request');
        if (request.method === 'PATCH') {
          saved = ((await request.json()) as { value: string }).value;
          writes.push(saved);
        }
        return new Response(
          JSON.stringify({ key: updateBackupModeKey, value: saved }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const status: ManagerStatus = {
      available: true,
      environment: 'development',
      mode: 'observe',
      dockerConnected: true,
      components: [],
      dataSafety: { status: 'protected', blockers: [], protectedMounts: [] },
      capabilities: { backupSelection: true },
      update: { busy: false, operation: null },
    };
    render(
      <QueryClientProvider client={client}>
        <div className="min-h-screen bg-background p-4 text-foreground">
          <ManagerUpdateControls status={status} showBackups={false} />
        </div>
      </QueryClientProvider>,
    );
    try {
      const select = screen.getByRole('combobox', {
        name: 'Stratégie de sauvegarde',
      });
      expect(select).toHaveValue('full');
      expect(screen.getAllByRole('option')).toHaveLength(3);
      await waitFor(() => expect(select).toBeEnabled());
      fireEvent.change(select, { target: { value: 'minimal' } });
      expect(await screen.findByText(/Aucun fichier de projet/)).toBeVisible();
      expect(writes).toHaveLength(0);
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Enregistrer le choix de sauvegarde',
        }),
      );
      expect(
        await screen.findByText('Choix de sauvegarde enregistré.'),
      ).toBeVisible();
      expect(writes).toEqual(['minimal']);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/backup-modes-${width}.png`,
      });
      fireEvent.change(select, { target: { value: 'none' } });
      expect(
        await screen.findByText(/Aucune donnée ne sera sauvegardée/),
      ).toBeVisible();
    } finally {
      client.clear();
    }
  },
);
