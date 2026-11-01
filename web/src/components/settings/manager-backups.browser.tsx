/** Full Server settings layout with backup fixtures; no live backup operations. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { GeneralSettings } from './general-settings';
import { ManagerBackups } from './manager-backups';
import type { ManagerStatus } from './manager-status-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

vi.mock('./use-category-settings', () => ({
  useCategorySettings: () => ({
    settings: [],
    drafts: {},
    isDirty: false,
    isLoading: false,
  }),
}));
vi.mock('./server-version-card', () => ({
  ServerVersionCard: ({ view }: { view: string }) =>
    view === 'backups' ? (
      <ManagerBackups
        status={
          {
            available: true,
            capabilities: { backupManagement: true, backupRetention: true },
            update: { busy: false, operation: null },
          } as ManagerStatus
        }
      />
    ) : (
      <div>Version</div>
    ),
}));
vi.mock('./manager-status-api', async (original) => ({
  ...(await original<typeof import('./manager-status-api')>()),
  requestManagerRetention: async () => ({ maxBackups: 10 }),
  requestManagerBackups: async () => ({
    totalSizeBytes: null,
    sizesCalculating: true,
    backups: [
      {
        id: 'd2a55d6f-2bf0-484b-a293-c4526aa4acd8',
        createdAt: '2026-10-26T22:41:08Z',
        path: '/mnt/pool/appdata/mergeron-dev/state/manager-state/updates/d2a55d6f-2bf0-484b-a293-c4526aa4acd8/backup',
        sizeBytes: null,
        sizeStatus: 'calculating',
        current: true,
        restorable: true,
        canDelete: true,
        protectionReason: null,
      },
    ],
  }),
}));
afterEach(cleanup);
test.each([1000, 1295, 390])(
  'uses all available width and keeps backup columns accessible at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <div className="flex h-[850px] w-full flex-col">
          <GeneralSettings />
        </div>
      </QueryClientProvider>,
    );
    try {
      await page
        .getByRole('tab', { name: 'Restauration', exact: true })
        .click();
      await screen.findByText('d2a55d6f-2bf0-484b-a293-c4526aa4acd8');
      const table = screen.getByRole('table');
      const scroller = table.parentElement!;
      expect(scroller.getBoundingClientRect().width).toBeGreaterThanOrEqual(
        width - 48,
      );
      expect(screen.getByRole('columnheader', { name: 'Date' })).toBeVisible();
      expect(
        screen.getByRole('columnheader', { name: 'Identifiant' }),
      ).toBeVisible();
      if (width >= 1000) {
        expect(scroller.scrollWidth).toBeLessThanOrEqual(
          scroller.clientWidth + 1,
        );
        const action = screen.getByRole('button', {
          name: 'Supprimer la sauvegarde',
        });
        expect(action.getBoundingClientRect().right).toBeLessThanOrEqual(
          scroller.getBoundingClientRect().right,
        );
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/backup-table-${width}.png`,
      });
      await page
        .getByRole('tab', { name: 'Version actuelle', exact: true })
        .click();
      expect(document.querySelector('.max-w-7xl')).not.toBeNull();
    } finally {
      client.clear();
    }
  },
);
