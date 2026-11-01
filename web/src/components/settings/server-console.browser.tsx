/** Real settings tabs and components; all external boundaries use local fixtures. */
import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { client as apiClient } from '@/generated/api/client.gen';
import { GeneralSettings } from './general-settings';
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const digest = 'sha256:' + 'a'.repeat(64);
const build = {
  version: '0.6.0',
  revision: 'b'.repeat(40),
  builtAt: '2026-11-01T10:00:00Z',
  channel: 'edge',
};
const backupId = 'd2a55d6f-2bf0-484b-a293-c4526aa4acd8';
const components = ['application', 'browser', 'ingress', 'egress'].map(
  (id) => ({
    id,
    displayName: id,
    build:
      id === 'ingress'
        ? { ...build, version: '1.30.6', revision: null, channel: 'unknown' }
        : id === 'egress'
          ? { ...build, version: '6.13', revision: null, channel: 'unknown' }
          : build,
    imageId: digest,
  }),
);
const status = {
  available: true,
  mode: 'observe',
  environment: 'development',
  components,
  manager: { build, imageId: digest },
  capabilities: {
    backupSelection: true,
    backupRetention: true,
    backupManagement: true,
    backupRestore: true,
    updateHistory: true,
  },
  dataSafety: { status: 'protected', blockers: [], protectedMounts: [] },
  update: { busy: false, operation: null },
};
const updates = {
  checkedAt: '2026-11-01T10:00:00Z',
  components: [
    ...components,
    { id: 'manager', displayName: 'Manager', build, imageId: digest },
  ].map((c) => ({
    id: c.id,
    displayName: c.displayName,
    targetImage:
      c.id === 'ingress'
        ? 'nginx:stable'
        : c.id === 'egress'
          ? 'ubuntu/squid:latest'
          : `ghcr.io/maxhugit/mergeron${c.id === 'application' ? '' : '-' + c.id}:edge`,
    targetDigest: digest,
    installedBuild: c.build,
    targetBuild: c.id === 'browser' ? { ...build, version: '0.6.1' } : build,
    updateAvailable: c.id === 'browser',
    versionStatus: c.id === 'browser' ? 'update_available' : 'current',
    checkError: null,
  })),
};

test.each([1100, 390])(
  'manages updates, history logs and restoration without page overflow at %ipx',
  async (width) => {
    await page.viewport(width, 913);
    await i18nReady;
    await i18n.changeLanguage('fr');
    let backupMode = 'full';
    let retained = 10;
    let applied = false;
    const responder = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request
          ? input
          : new Request(new URL(String(input), window.location.origin), init);
      const path = new URL(request.url).pathname;
      let value: unknown = {};
      if (path.endsWith('/release/status'))
        value = {
          installed: build,
          latestVersion: '0.6.0',
          checkedAt: '2026-11-01T10:00:00Z',
          releases: [],
          checkError: null,
        };
      else if (path.endsWith('/manager/status')) value = status;
      else if (path.includes('/manager/image-updates')) value = updates;
      else if (path.endsWith('/general.updateBackupMode')) {
        if (request.method === 'PATCH')
          backupMode = (await request.json()).value;
        value = { key: 'general.updateBackupMode', value: backupMode };
      } else if (path.endsWith('/backups/retention')) {
        if (request.method === 'POST')
          retained = (await request.json()).maxBackups;
        value = { maxBackups: retained };
      } else if (path.endsWith('/manager/backups'))
        value = {
          backups: [
            {
              id: backupId,
              createdAt: '2026-11-01T09:00:00Z',
              backupPolicy: 'full-v1',
              sizeBytes: 1400000000,
              status: 'succeeded',
              restorable: true,
              canDelete: true,
              path:
                '/srv/mergeron/manager-state/updates/' + backupId + '/backup',
              protectionReason: null,
            },
          ],
          totalSizeBytes: 1400000000,
        };
      else if (path.endsWith('/update/history'))
        value = {
          operations: [
            {
              id: backupId,
              status: 'rolledBack',
              phase: 'complete',
              startedAt: '2026-11-01T09:00:00Z',
              finishedAt: '2026-11-01T09:05:00Z',
              actor: { id: 'admin', name: 'Administrateur de test' },
              builds: {
                browser: { from: build, to: { ...build, version: '0.6.1' } },
              },
              error: 'updateHealthCheckTimeout',
              events: [
                {
                  at: '2026-11-01T09:01:00Z',
                  phase: 'checkingHealth',
                  status: 'running',
                },
                {
                  at: '2026-11-01T09:05:00Z',
                  phase: 'complete',
                  status: 'rolledBack',
                },
              ],
            },
          ],
        };
      else if (
        path.endsWith('/restore-plan') ||
        path.endsWith('/checkpoint-plan')
      )
        value = {
          applicable: true,
          fingerprint: 'fixture-plan',
          images: { application: `ghcr.io/maxhugit/mergeron@${digest}` },
          backupPolicy: 'full-v1',
          restorePolicy: 'full-v1',
          blockers: [],
        };
      else if (
        path.endsWith('/manager/update') ||
        path.endsWith('/update/restore') ||
        path.endsWith('/update/checkpoint')
      ) {
        applied = true;
        throw Error('A real update must never execute in a visual fixture');
      }
      return new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
    vi.stubGlobal('fetch', responder);
    apiClient.setConfig({ baseUrl: window.location.origin, fetch: responder });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <div className="flex h-dvh min-h-0 w-full flex-col bg-background text-foreground">
          <GeneralSettings />
        </div>
      </QueryClientProvider>,
    );
    try {
      await screen.findByRole('row', { name: /Mergeron Browser/ });
      await waitFor(() =>
        expect(
          screen.getByRole('button', {
            name: 'Mettre à jour la sélection (1)',
          }),
        ).toBeEnabled(),
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/server-console-current-${width}.png`,
      });
      await page
        .getByRole('tab', { name: 'Journal des mises à jour', exact: true })
        .click();
      await screen.findByText('Administrateur de test', { exact: false });
      await page
        .getByRole('button', { name: 'Voir le log', exact: true })
        .click();
      expect(
        await screen.findByText('Une erreur a été enregistrée.'),
      ).toBeVisible();
      expect(
        screen.getByText(
          'Un service n’est pas devenu opérationnel dans le délai prévu.',
        ),
      ).toBeVisible();
      await page.screenshot({
        path: `../../../.vitest-screenshots/server-console-log-${width}.png`,
      });
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page
        .getByRole('tab', { name: 'Restauration', exact: true })
        .click();
      const select = await screen.findByRole('combobox', {
        name: 'Stratégie de sauvegarde',
      });
      await waitFor(() => expect(select).toBeEnabled());
      fireEvent.change(select, { target: { value: 'minimal' } });
      await screen.findByText(/Base et configuration uniquement/);
      const retention = await screen.findByRole('spinbutton', {
        name: 'Nombre de sauvegardes à conserver',
      });
      fireEvent.change(retention, { target: { value: '15' } });
      const backupTable = screen.getByRole('table');
      const backupScroller = backupTable.parentElement!;
      expect(backupScroller.clientHeight).toBeGreaterThan(100);
      for (
        let parent = backupScroller.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        expect(parent.scrollHeight).toBeLessThanOrEqual(
          parent.clientHeight + 1,
        );
      }
      expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(914);
      const refreshBackups = screen.getByRole('button', { name: 'Actualiser' });
      expect(refreshBackups.getBoundingClientRect().bottom).toBeLessThan(
        backupScroller.getBoundingClientRect().top,
      );

      await page.screenshot({
        path: `../../../.vitest-screenshots/server-console-restore-${width}.png`,
      });
      await page
        .getByRole('button', { name: 'Restaurer', exact: true })
        .click();
      await screen.findByText(
        'Une sauvegarde complète de l’état actuel sera créée avant de restaurer. En cas d’échec, le Manager tentera de rétablir cet état.',
      );
      await page
        .getByRole('button', {
          name: 'Vérifier la restauration',
          exact: true,
        })
        .click();
      const confirm = await screen.findByRole('button', {
        name: 'Confirmer la restauration',
      });
      expect(confirm).toBeDisabled();
      expect(applied).toBe(false);
      await page.screenshot({
        path: `../../../.vitest-screenshots/server-console-confirm-${width}.png`,
      });
      await page.getByRole('button', { name: 'Annuler', exact: true }).click();
      await page
        .getByRole('button', { name: 'Créer une sauvegarde', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Vérifier la sauvegarde', exact: true })
        .click();
      const backupDialog = await screen.findByRole('dialog');
      const manualConfirm = within(backupDialog).getByRole('button', {
        name: 'Créer une sauvegarde',
      });
      expect(manualConfirm).toBeDisabled();
      fireEvent.click(within(backupDialog).getByRole('checkbox'));
      expect(manualConfirm).toBeEnabled();
      expect(applied).toBe(false);
    } finally {
      client.clear();
    }
  },
);
