import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { catalogFixture, json } from './catalog/catalog.testing';
import { ManagerUpdateControls } from './manager-update-controls';
import type { ManagerStatus } from './manager-status-api';
import {
  updateBackupModeKey,
  updateBackupModeQueryKey,
} from './use-update-backup-mode';

vi.mock('./server-release-api', async (original) => ({
  ...(await original<typeof import('./server-release-api')>()),
  requestServerRelease: async () => ({
    installed: { version: '0.5.1', channel: 'edge' },
    targetImage: 'ghcr.io/maxhugit/mergeron:edge',
    updateAvailable: true,
    releases: [],
  }),
}));
vi.mock('./manager-image-updates', () => ({
  ManagerImageUpdates: ({
    onUpdate,
    disabled,
  }: {
    onUpdate: (images: Record<string, string>) => void;
    disabled: boolean;
  }) => (
    <button
      disabled={disabled}
      onClick={() => onUpdate({ ingress: `nginx@sha256:${'b'.repeat(64)}` })}
    >
      Test ingress update
    </button>
  ),
}));

const status: ManagerStatus = {
  available: true,
  environment: 'development',
  mode: 'observe',
  dockerConnected: true,
  components: [],
  capabilities: { backupSelection: true },
  dataSafety: { status: 'protected', blockers: [], protectedMounts: [] },
  update: { busy: false, operation: null },
};
const preferencePath = `/api/settings/${updateBackupModeKey}`;
let fixture: ReturnType<typeof catalogFixture>;
beforeEach(async () => {
  sessionStorage.clear();
  fixture = catalogFixture();
  fixture.server.overrides.set(`GET ${preferencePath}`, () =>
    json({ key: updateBackupModeKey, value: 'full' }),
  );
  await i18n.changeLanguage('fr');
});
afterEach(() => {
  sessionStorage.clear();
  fixture.dispose();
  vi.unstubAllGlobals();
});

it.each([
  ['full', 'Mettre à jour'],
  ['minimal', 'Mettre à jour'],
  ['none', 'Mettre à jour'],
  ['full', 'Test ingress update'],
  ['minimal', 'Test ingress update'],
  ['none', 'Test ingress update'],
] as const)(
  'saves %s, reloads it from the server on a fresh visit and uses it for %s plan AND execution',
  async (value, trigger) => {
    const user = userEvent.setup();
    let persisted = value === 'full' ? 'minimal' : 'full';
    const read = () => json({ key: updateBackupModeKey, value: persisted });
    fixture.server.overrides.set(`GET ${preferencePath}`, read);
    fixture.server.overrides.set(`PATCH ${preferencePath}`, async (request) => {
      persisted = ((await request.json()) as { value: string }).value;
      return read();
    });
    const view = fixture.render(<ManagerUpdateControls status={status} />);
    const select = screen.getByRole('combobox');
    await waitFor(() => expect(select).toHaveValue(persisted));
    await waitFor(() => expect(select).toBeEnabled());
    expect(fixture.server.writes).toHaveLength(0);
    await user.selectOptions(select, value);
    expect(persisted).not.toBe(value);
    await user.click(
      screen.getByRole('button', {
        name: 'Enregistrer le choix de sauvegarde',
      }),
    );
    expect(
      await screen.findByText('Choix de sauvegarde enregistré.'),
    ).toBeVisible();
    expect(fixture.server.writes).toEqual([
      { method: 'PATCH', path: preferencePath, body: { value } },
    ]);
    expect(persisted).toBe(value);
    view.unmount();
    fixture.dispose();
    // No query cache or browser storage survives this fresh visit.
    fixture = catalogFixture();
    fixture.server.overrides.set(`GET ${preferencePath}`, read);
    await i18n.changeLanguage('fr');
    const calls = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!init?.body) return json(status);
        const body = JSON.parse(String(init?.body ?? '{}'));
        return json(
          body.expectedFingerprint
            ? { busy: true, operation: null }
            : {
                applicable: true,
                fingerprint: 'saved-scope',
                blockers: [],
                images: body.images,
                backupMode: body.backupMode,
                backupPolicy: `${body.backupMode}-v1`,
              },
        );
      },
    );
    vi.stubGlobal('fetch', calls);
    fixture.render(<ManagerUpdateControls status={status} />);
    await waitFor(() =>
      expect(screen.getByRole('combobox')).toHaveValue(value),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: trigger })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: trigger }));
    const confirmation = await screen.findByRole('alertdialog');
    expect(confirmation).toHaveTextContent(
      value === 'minimal'
        ? /La base entière et la configuration/
        : value === 'none'
          ? /Aucune donnée ne sera sauvegardée/
          : /indisponibles pendant la sauvegarde/,
    );
    // A later server preference must not change the scope already reviewed.
    if (value === 'minimal') {
      fixture.queryClient.setQueryData(updateBackupModeQueryKey, 'full');
    }
    await user.click(
      screen.getByRole('button', { name: 'Installer et redémarrer' }),
    );
    const updates = () =>
      calls.mock.calls.filter(([, init]) => init?.method === 'POST');
    await waitFor(() => expect(updates()).toHaveLength(2));
    const bodies = updates().map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0].backupMode).toBe(value);
    expect(bodies[1]).toMatchObject({
      images: bodies[0].images,
      backupMode: value,
      expectedFingerprint: 'saved-scope',
      confirmation:
        value === 'none'
          ? 'UPDATE_WITHOUT_DATA_BACKUP'
          : 'UPDATE_WITH_ROLLBACK',
    });
  },
);

it.each([503, 'invalid'] as const)(
  'blocks preparation on an unreadable preference (%s) and retries without issuing an update',
  async (failure) => {
    const user = userEvent.setup();
    fixture.server.overrides.set(`GET ${preferencePath}`, () =>
      failure === 503
        ? json({ message: 'unavailable' }, 503)
        : json({ value: 'unknown-policy' }),
    );
    fixture.render(<ManagerUpdateControls status={status} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Impossible de lire le choix enregistré',
    );
    expect(
      screen.getByRole('button', { name: 'Mettre à jour' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Test ingress update' }),
    ).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();
    fixture.server.overrides.set(`GET ${preferencePath}`, () =>
      json({ value: 'minimal' }),
    );
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox')).toHaveValue('minimal'),
    );
    expect(fixture.server.writes).toHaveLength(0);
  },
);

it('keeps an unsuccessful save as a draft and does not claim it was persisted', async () => {
  const user = userEvent.setup();
  const write = vi.fn(() => json({ message: 'database unavailable' }, 503));
  fixture.server.overrides.set(`PATCH ${preferencePath}`, write);
  fixture.render(<ManagerUpdateControls status={status} />);
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
  await user.selectOptions(screen.getByRole('combobox'), 'minimal');
  await user.click(
    screen.getByRole('button', { name: 'Enregistrer le choix de sauvegarde' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Le choix n’a pas pu être enregistré',
  );
  expect(screen.getByRole('combobox')).toHaveValue('minimal');
  expect(
    screen.queryByText('Choix de sauvegarde enregistré.'),
  ).not.toBeInTheDocument();
  expect(write).toHaveBeenCalledTimes(1);
  expect(fixture.queryClient.getQueryData(updateBackupModeQueryKey)).toBe(
    'full',
  );
});
