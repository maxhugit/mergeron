import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { catalogFixture, json } from './catalog/catalog.testing';
import { ServerVersionCard } from './server-version-card';
import { GeneralSettings } from './general-settings';
import {
  managerStatusQueryKey,
  type ManagerStatus,
} from './manager-status-api';
import { componentUpdatesKey } from './manager-image-updates-api';
let fixture: ReturnType<typeof catalogFixture>;
let currentManager: ManagerStatus;
const digest = 'sha256:' + 'a'.repeat(64);
const build = {
  version: '0.6.0',
  revision: 'b'.repeat(40),
  builtAt: '2026-11-01T10:00:00Z',
  channel: 'edge',
};
const manager = {
  available: true,
  mode: 'observe',
  dockerConnected: true,
  components: [{ id: 'browser', build, imageId: digest }],
  capabilities: {
    backupSelection: true,
    updateHistory: true,
    backupRestore: true,
    backupManagement: true,
    backupRetention: true,
  },
  dataSafety: { status: 'protected', blockers: [], protectedMounts: [] },
  update: { busy: false, operation: null },
} as unknown as ManagerStatus;
const updates = {
  checkedAt: '2026-11-01T10:00:00Z',
  components: [
    {
      id: 'browser',
      displayName: 'Browser',
      installedImageId: digest,
      installedBuild: build,
      targetImage: 'ghcr.io/maxhugit/mergeron-browser:edge',
      targetDigest: digest,
      targetBuild: { ...build, version: '0.6.1' },
      updateAvailable: true,
      versionStatus: 'update_available',
      checkError: null,
    },
  ],
};
beforeEach(async () => {
  await i18n.changeLanguage('en');
  fixture = catalogFixture();
  currentManager = manager;
  fixture.server.overrides.set(
    'GET /api/settings/general.updateBackupMode',
    () => json({ key: 'general.updateBackupMode', value: 'full' }),
  );
  fixture.queryClient.setQueryData(managerStatusQueryKey, manager);
  fixture.queryClient.setQueryData(componentUpdatesKey, updates);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('image-updates')) return json(updates);
      if (url.endsWith('/manager/status')) return json(currentManager);
      if (url.endsWith('/manager/update/history'))
        return json({ operations: [] });
      if (url.includes('/release/status'))
        return json({
          installed: build,
          latestVersion: '0.6.1',
          checkedAt: '2026-11-01T10:00:00Z',
          releases: [],
          checkError: null,
        });
      if (url.endsWith('/backups/retention')) return json({ maxBackups: 10 });
      if (url.endsWith('/manager/backups')) return json({ backups: [] });
      if (url.endsWith('/manager/update/plan'))
        return json({
          applicable: true,
          fingerprint: 'plan',
          images: JSON.parse(String(init?.body)).images,
          backupPolicy: 'full-v1',
          backupMode: 'full',
          blockers: [],
        });
      return json({});
    }),
  );
});
afterEach(() => {
  fixture.dispose();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
it('shows Browser and prepares its exact immutable update before confirmation', async () => {
  fixture.render(<ServerVersionCard view="current" />);
  const row = await screen.findByRole('row', { name: /Mergeron Browser/ });
  expect(within(row).getByText('0.6.1')).toBeVisible();
  const button = within(row).getByRole('button', { name: 'Update' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(await screen.findByRole('alertdialog')).toBeVisible();
  const calls = vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => String(url).endsWith('/update/plan'));
  expect(JSON.parse(String(calls[0][1]?.body)).images).toEqual({
    browser: `ghcr.io/maxhugit/mergeron-browser@${digest}`,
  });
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([url]) => String(url).endsWith('/manager/update')),
  ).toBe(false);
});
it('requires a new Manager instead of component writes with an older protocol', async () => {
  currentManager = { ...manager, capabilities: { backupSelection: true } };
  fixture.queryClient.setQueryData(managerStatusQueryKey, currentManager);
  fixture.render(<ServerVersionCard view="current" />);
  expect(
    await screen.findByText(
      'Update the Manager on the host before using this console.',
    ),
  ).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Update selected (1)' }),
  ).toBeDisabled();
});
it('places history and restoration on separate tabs with keyboard navigation', async () => {
  fixture.render(<GeneralSettings />);
  const journal = await screen.findByRole('tab', { name: 'Update history' });
  fireEvent.click(journal);
  expect(await screen.findByText('No recorded operations.')).toBeVisible();
  journal.focus();
  fireEvent.keyDown(journal, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Restore' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(
    await screen.findByRole('spinbutton', {
      name: 'Number of backups to keep',
    }),
  ).toBeVisible();
  expect(screen.queryByText(/fast update/i)).not.toBeInTheDocument();
});
it('keeps installed versions readable when Manager is unavailable', async () => {
  currentManager = { ...manager, available: false };
  fixture.queryClient.setQueryData(managerStatusQueryKey, currentManager);
  fixture.render(<ServerVersionCard />);
  expect(await screen.findByText('0.6.0')).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Update selected (1)' }),
  ).toBeDisabled();
});
