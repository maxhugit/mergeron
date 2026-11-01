import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { catalogFixture, deferred, json } from './catalog/catalog.testing';
import { ManagerUpdateControls } from './manager-update-controls';
import { updateBackupModeKey } from './use-update-backup-mode';
import type { ManagerStatus } from './manager-status-api';
import {
  readManagerUpdateReceipt,
  saveManagerUpdateReceipt,
} from './manager-update-recovery';
import {
  requestServerRelease,
  type ServerReleaseStatus,
} from './server-release-api';

vi.mock('./server-release-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./server-release-api')>()),
  requestServerRelease: vi.fn(),
}));
vi.mock('./manager-image-updates', () => ({
  ManagerImageUpdates: ({
    onUpdate,
  }: {
    onUpdate: (images: Record<string, string>) => void;
  }) => (
    <button
      onClick={() => onUpdate({ ingress: `nginx@sha256:${'b'.repeat(64)}` })}
    >
      Test ingress update
    </button>
  ),
  componentUpdatesKey: ['administration', 'component-image-updates'],
}));

const release: ServerReleaseStatus = {
  installed: {
    version: '0.1.0',
    revision: null,
    builtAt: null,
    channel: 'stable',
  },
  latestVersion: '0.1.1',
  latestPublishedAt: null,
  latestUrl: null,
  updateAvailable: true,
  versionStatus: 'update_available',
  releases: [],
  checkedAt: '2026-10-24T00:00:00Z',
  checkError: null,
};

let fixture: ReturnType<typeof catalogFixture>;
const status: ManagerStatus = {
  available: true,
  environment: 'production',
  mode: 'observe',
  dockerConnected: true,
  components: [],
  dataSafety: { status: 'protected', blockers: [], protectedMounts: [] },
  update: { busy: false, operation: null },
};
beforeEach(async () => {
  sessionStorage.clear();
  fixture = catalogFixture();
  fixture.server.overrides.set(`GET /api/settings/${updateBackupModeKey}`, () =>
    json({ key: updateBackupModeKey, value: 'full' }),
  );
  vi.mocked(requestServerRelease).mockReset();
  vi.mocked(requestServerRelease).mockResolvedValue(release);
  await i18n.changeLanguage('fr');
});

it('never offers the removed fast update mode', async () => {
  const view = fixture.render(
    <ManagerUpdateControls status={{ ...status, capabilities: {} }} />,
  );
  expect(
    screen.queryByRole('checkbox', {
      name: 'Mise à jour rapide — dev uniquement',
    }),
  ).not.toBeInTheDocument();
  view.unmount();
  fixture.render(
    <ManagerUpdateControls
      status={{
        ...status,
        environment: 'development',
        capabilities: {},
      }}
    />,
  );
  expect(
    screen.queryByRole('checkbox', {
      name: 'Mise à jour rapide — dev uniquement',
    }),
  ).not.toBeInTheDocument();
});

it.each(['development-none-v1', 'production-essential-v1'] as const)(
  'confirms the actual %s policy instead of promising a full backup',
  async (backupPolicy) => {
    const user = userEvent.setup();
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.expectedFingerprint)
          return json({ busy: true, operation: null });
        return json({
          applicable: true,
          fingerprint: 'policy-checked',
          blockers: [],
          backupPolicy,
          images: { application: 'ghcr.io/maxhugit/mergeron:edge' },
        });
      },
    );
    vi.stubGlobal('fetch', fetch);
    fixture.render(
      <ManagerUpdateControls
        status={{
          ...status,
          backupPolicy,
          environment:
            backupPolicy === 'development-none-v1'
              ? 'development'
              : 'production',
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Mettre à jour' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(
      backupPolicy === 'development-none-v1'
        ? 'Aucune donnée ne sera sauvegardée en Dev'
        : 'sauvegarde des données essentielles',
    );
    await user.click(
      screen.getByRole('button', { name: 'Installer et redémarrer' }),
    );
    expect(
      fetch.mock.calls.some(
        ([, init]) =>
          JSON.parse(String(init?.body ?? '{}')).confirmation ===
          (backupPolicy === 'development-none-v1'
            ? 'UPDATE_WITHOUT_DATA_BACKUP'
            : 'UPDATE_WITH_ROLLBACK'),
      ),
    ).toBe(true);
  },
);
afterEach(() => {
  sessionStorage.clear();
  fixture.dispose();
  vi.unstubAllGlobals();
});

it.each(['production', 'development'] as const)(
  'offers all backup scopes in %s, including individual container updates',
  async (environment) => {
    const user = userEvent.setup();
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.expectedFingerprint)
          return json({ busy: true, operation: null });
        return json({
          applicable: true,
          fingerprint: 'scope-checked',
          blockers: [],
          images: body.images,
          backupMode: body.backupMode,
          backupPolicy: `${body.backupMode}-v1`,
        });
      },
    );
    vi.stubGlobal('fetch', fetch);
    fixture.render(
      <ManagerUpdateControls
        status={{
          ...status,
          environment,
          capabilities: { backupSelection: true },
        }}
      />,
    );
    const select = screen.getByRole('combobox', {
      name: 'Stratégie de sauvegarde',
    });
    expect(select).toHaveValue('full');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, 'minimal');
    expect(screen.getByText(/Aucun fichier de projet/)).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Test ingress update' }),
    );
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      /La base entière et la configuration/,
    );
    await user.click(
      screen.getByRole('button', { name: 'Installer et redémarrer' }),
    );
    expect(
      fetch.mock.calls.some(([, init]) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return (
          body.expectedFingerprint === 'scope-checked' &&
          body.backupMode === 'minimal' &&
          body.confirmation === 'UPDATE_WITH_ROLLBACK' &&
          body.images.ingress
        );
      }),
    ).toBe(true);
  },
);

it('explicitly confirms no backup in production and does not enable selection on older Managers', async () => {
  const user = userEvent.setup();
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.expectedFingerprint) return json({ busy: true, operation: null });
    return json({
      applicable: true,
      fingerprint: 'none-checked',
      blockers: [],
      images: body.images,
      backupMode: 'none',
      backupPolicy: 'none-v1',
    });
  });
  vi.stubGlobal('fetch', fetch);
  const view = fixture.render(<ManagerUpdateControls status={status} />);
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  view.unmount();
  fixture.render(
    <ManagerUpdateControls
      status={{ ...status, capabilities: { backupSelection: true } }}
    />,
  );
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
  await user.selectOptions(screen.getByRole('combobox'), 'none');
  await user.click(screen.getByRole('button', { name: 'Mettre à jour' }));
  expect(await screen.findByRole('alertdialog')).toHaveTextContent(
    /Aucune donnée ne sera sauvegardée/,
  );
  await user.click(
    screen.getByRole('button', { name: 'Installer et redémarrer' }),
  );
  expect(
    fetch.mock.calls.some(
      ([, init]) =>
        JSON.parse(String(init?.body ?? '{}')).confirmation ===
        'UPDATE_WITHOUT_DATA_BACKUP',
    ),
  ).toBe(true);
});

it('reopens the completed update after the authenticated workspace was remounted without replaying it', async () => {
  const completed: ManagerStatus = {
    ...status,
    update: {
      busy: false,
      operation: {
        id: 'update-surviving-restart',
        status: 'succeeded',
        phase: 'complete',
        events: [],
        images: {},
        previousImages: {},
        backupRetained: true,
      },
    },
  };
  saveManagerUpdateReceipt({
    startedAt: Date.now(),
    operationId: 'update-surviving-restart',
    excludedOperationId: 'previous-update',
  });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return json(completed);
  });
  vi.stubGlobal('fetch', fetch);
  fixture.render(<ManagerUpdateControls status={completed} />);
  expect(
    await screen.findByRole('dialog', { name: 'Suivi de la mise à jour' }),
  ).toBeVisible();
  expect(screen.getAllByText('Mise à jour réussie').length).toBeGreaterThan(0);
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(
    false,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Fermer' }));
  expect(readManagerUpdateReceipt()).toBeNull();
});

it('keeps progress locked during an active update without cancelling or replaying it', async () => {
  const update = {
    busy: true,
    operation: {
      id: 'active',
      status: 'running',
      phase: 'preparing',
      events: [],
      images: {},
      previousImages: {},
      backupRetained: false,
    },
  };
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      json(
        init?.method === 'POST'
          ? String(input).endsWith('/plan')
            ? {
                applicable: true,
                fingerprint: 'reviewed',
                blockers: [],
                images: { application: 'ghcr.io/maxhugit/mergeron:0.1.1' },
              }
            : update
          : { ...status, update },
      ),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  fixture.render(<ManagerUpdateControls status={status} />);
  const user = userEvent.setup();
  await screen.findByDisplayValue('ghcr.io/maxhugit/mergeron:0.1.1');
  await user.click(screen.getByRole('button', { name: 'Mettre à jour' }));
  await screen.findByRole('alertdialog');
  await user.click(
    screen.getByRole('button', { name: 'Installer et redémarrer' }),
  );
  await screen.findByRole('dialog', { name: 'Suivi de la mise à jour' });
  await waitFor(() =>
    expect(readManagerUpdateReceipt()?.operationId).toBe('active'),
  );
  expect(screen.getByRole('button', { name: 'Fermer' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Fermer' }));
  expect(
    await screen.findByRole('dialog', { name: 'Suivi de la mise à jour' }),
  ).toBeVisible();
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(2);
});

it('previews without applying and requires a second explicit confirmation', async () => {
  const user = userEvent.setup();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return json({
      applicable: true,
      fingerprint: 'checked',
      blockers: [],
      images: { application: 'ghcr.io/maxhugit/mergeron:0.1.1' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  fixture.render(<ManagerUpdateControls status={status} />);
  await screen.findByDisplayValue('ghcr.io/maxhugit/mergeron:0.1.1');
  await user.click(screen.getByRole('button', { name: 'Mettre à jour' }));
  await screen.findByRole('alertdialog');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    images: { application: 'ghcr.io/maxhugit/mergeron:0.1.1' },
  });
  expect(screen.getByRole('alertdialog')).toHaveTextContent(
    'Les services seront indisponibles',
  );
  await user.click(
    screen.getByRole('button', { name: 'Installer et redémarrer' }),
  );
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(2);
  expect(
    await screen.findByRole('dialog', { name: 'Suivi de la mise à jour' }),
  ).toBeVisible();
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
    confirmation: 'UPDATE_WITH_ROLLBACK',
    expectedFingerprint: 'checked',
  });
});

it('explains a Manager timeout in French without retrying or applying an unconfirmed plan', async () => {
  const fetch = vi.fn(async () =>
    json({ message: 'mergeronManagerTimeout' }, 504),
  );
  vi.stubGlobal('fetch', fetch);
  fixture.render(<ManagerUpdateControls status={status} />);
  await screen.findByDisplayValue('ghcr.io/maxhugit/mergeron:0.1.1');
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Mettre à jour' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Le Manager n’a pas répondu dans le délai prévu',
  );
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Vérifiez l’état de l’opération avant de réessayer',
  );
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('uses edge only for an explicitly declared development stack', () => {
  fixture.render(
    <ManagerUpdateControls
      status={{ ...status, environment: 'development' }}
    />,
  );
  expect(
    screen.getByDisplayValue('ghcr.io/maxhugit/mergeron:edge'),
  ).toHaveValue('ghcr.io/maxhugit/mergeron:edge');
  expect(requestServerRelease).toHaveBeenCalled();
});

it('does not overwrite a manually selected image when release discovery completes', async () => {
  const pending = deferred<ServerReleaseStatus>();
  vi.mocked(requestServerRelease).mockReturnValue(pending.promise);
  fixture.render(<ManagerUpdateControls status={status} />);
  const user = userEvent.setup();
  expect(
    screen.queryByText('Options avancées : choisir une autre image'),
  ).not.toBeInTheDocument();
  const input = screen.getByRole('textbox');
  await user.clear(input);
  await user.type(input, 'ghcr.io/maxhugit/mergeron:0.1.2');
  await act(async () => pending.resolve(release));
  expect(input).toHaveValue('ghcr.io/maxhugit/mergeron:0.1.2');
});

it('waits for automatic discovery before requesting a plan', async () => {
  const pending = deferred<ServerReleaseStatus>();
  vi.mocked(requestServerRelease).mockReturnValue(pending.promise);
  const fetch = vi.fn(async () =>
    json({
      applicable: true,
      fingerprint: 'checked',
      blockers: [],
      images: { application: 'ghcr.io/maxhugit/mergeron:0.1.1' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  fixture.render(<ManagerUpdateControls status={status} />);
  const user = userEvent.setup();
  expect(screen.getByRole('button', { name: 'Mettre à jour' })).toBeDisabled();
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => pending.resolve(release));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Mettre à jour' })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: 'Mettre à jour' }));
  await screen.findByRole('alertdialog');
  expect(
    screen.getByDisplayValue('ghcr.io/maxhugit/mergeron:0.1.1'),
  ).toHaveValue('ghcr.io/maxhugit/mergeron:0.1.1');
});

it('requires an images-only confirmation for Dev rollback even when no data backup exists', async () => {
  const user = userEvent.setup();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return json({});
  });
  vi.stubGlobal('fetch', fetch);
  const updated: ManagerStatus = {
    ...status,
    environment: 'development',
    backupPolicy: 'development-none-v1',
    update: {
      busy: false,
      operation: {
        id: 'dev-operation',
        status: 'succeeded',
        phase: 'complete',
        events: [],
        images: {},
        previousImages: {},
        backupRetained: false,
        rollbackAvailable: true,
        backupPolicy: 'development-none-v1',
      },
    },
  };
  fixture.render(<ManagerUpdateControls status={updated} />);
  await user.click(
    screen.getByRole('button', { name: 'Restaurer la version précédente' }),
  );
  expect(screen.getByRole('alertdialog')).toHaveTextContent(
    'sans restaurer les données',
  );
  expect(fetch).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Confirmer' }));
  expect(
    fetch.mock.calls.some(
      ([, init]) =>
        JSON.parse(String(init?.body ?? '{}')).confirmation ===
        'ROLLBACK_IMAGES_ONLY',
    ),
  ).toBe(true);
});

it('warns that rollback also restores data and does not run without confirmation', async () => {
  const user = userEvent.setup();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return json({});
  });
  vi.stubGlobal('fetch', fetch);
  const updated: ManagerStatus = {
    ...status,
    update: {
      busy: false,
      operation: {
        id: 'operation',
        status: 'succeeded',
        phase: 'complete',
        events: [],
        images: {},
        previousImages: {},
        backupRetained: true,
      },
    },
  };
  fixture.render(<ManagerUpdateControls status={updated} />);
  await user.click(
    screen.getByRole('button', { name: 'Restaurer la version précédente' }),
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByRole('alertdialog')).toHaveTextContent(
    'ET les données sauvegardées',
  );
  await user.click(screen.getByRole('button', { name: 'Confirmer' }));
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    confirmation: 'ROLLBACK_WITH_DATA_RESTORE',
    operationId: 'operation',
  });
});

it('has one update entry point, checks first, and installs only the immutable reviewed image after confirmation', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const target = `ghcr.io/maxhugit/mergeron@${digest}`;
  vi.mocked(requestServerRelease).mockResolvedValue({
    ...release,
    targetImage: 'ghcr.io/maxhugit/mergeron:latest',
    targetDigest: digest,
  });
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return Promise.resolve(
      json({
        applicable: true,
        fingerprint: 'immutable',
        blockers: [],
        images: { application: target },
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  fixture.render(<ManagerUpdateControls status={status} />);
  await screen.findByDisplayValue('ghcr.io/maxhugit/mergeron:latest');
  expect(
    screen.queryByRole('button', { name: 'Vérifier le plan de mise à jour' }),
  ).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Mettre à jour' }));
  await screen.findByRole('alertdialog');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    images: { application: target },
  });
  await user.click(
    screen.getByRole('button', { name: 'Installer et redémarrer' }),
  );
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
    images: { application: target },
    confirmation: 'UPDATE_WITH_ROLLBACK',
    expectedFingerprint: 'immutable',
  });
});

it('does not offer a default update when automatic detection reports no new image', async () => {
  vi.mocked(requestServerRelease).mockResolvedValue({
    ...release,
    targetImage: 'ghcr.io/maxhugit/mergeron:latest',
    updateAvailable: false,
  });
  fixture.render(<ManagerUpdateControls status={status} />);
  await screen.findByDisplayValue('ghcr.io/maxhugit/mergeron:latest');
  expect(screen.getByRole('button', { name: 'Mettre à jour' })).toBeDisabled();
});

it('previews the selected companion and applies only its reviewed image after confirmation', async () => {
  const target = `nginx@sha256:${'b'.repeat(64)}`;
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return Promise.resolve(
      json({
        applicable: true,
        fingerprint: 'ingress-reviewed',
        blockers: [],
        images: { ingress: target },
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  fixture.render(<ManagerUpdateControls status={status} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Test ingress update' }));
  const confirm = await screen.findByRole('alertdialog');
  expect(confirm).toHaveTextContent(`ingress: ${target}`);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    images: { ingress: target },
  });
  await user.click(
    screen.getByRole('button', { name: 'Installer et redémarrer' }),
  );
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
    images: { ingress: target },
    expectedFingerprint: 'ingress-reviewed',
    confirmation: 'UPDATE_WITH_ROLLBACK',
  });
});

it('keeps completed success out of the page while retaining access to its journal', async () => {
  fixture.render(
    <ManagerUpdateControls
      status={{
        ...status,
        update: {
          busy: false,
          operation: {
            id: 'done',
            status: 'succeeded',
            phase: 'complete',
            events: [],
            images: {},
            previousImages: {},
            backupRetained: true,
          },
        },
      }}
    />,
  );
  expect(screen.queryByText('Mise à jour réussie')).not.toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Voir le suivi et les logs' }),
  ).toBeEnabled();
});
