import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { QueryClientProvider } from '@tanstack/react-query';
import { catalogFixture, json } from './catalog/catalog.testing';
import { ManagerUpdateProgressDialog } from './manager-update-progress-dialog';
import type {
  ManagerStatus,
  ManagerUpdateOperation,
} from './manager-status-api';

let fixture: ReturnType<typeof catalogFixture>;
const operation: ManagerUpdateOperation = {
  id: 'current-operation',
  status: 'running',
  phase: 'backingUp',
  backupRetained: false,
  images: {},
  previousImages: {},
  events: [
    { at: '2026-10-25T09:00:00Z', phase: 'preparing', status: 'running' },
    { at: '2026-10-25T09:00:02Z', phase: 'backingUp', status: 'running' },
  ],
};
const props = {
  open: true,
  onOpenChange: vi.fn(),
  operation,
  pending: false,
  requestError: null,
  session: 1,
  excludedOperationId: null,
};
const response = (current: ManagerUpdateOperation): ManagerStatus => ({
  available: true,
  mode: 'observe',
  dockerConnected: true,
  components: [],
  dataSafety: { status: 'protected', blockers: [], protectedMounts: [] },
  update: { busy: current.status === 'running', operation: current },
});

beforeEach(async () => {
  fixture = catalogFixture();
  await i18n.changeLanguage('fr');
});

it('shows five real stages and no backup stage for a development transaction', async () => {
  const current: ManagerUpdateOperation = {
    ...operation,
    backupPolicy: 'development-none-v1',
    phase: 'replacing',
    events: [],
    backupRetained: false,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(response(current))),
  );
  fixture.render(
    <ManagerUpdateProgressDialog {...props} operation={current} />,
  );
  fireEvent.click(screen.getByText('Détails techniques'));
  expect(
    await screen.findByText(/Dev : aucune sauvegarde de données/),
  ).toBeVisible();
  expect(screen.queryByText('Sauvegarde des données')).not.toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '5');
});
afterEach(() => {
  fixture.dispose();
  vi.unstubAllGlobals();
});

it('does not claim the update started when the start response was lost', async () => {
  const fetch = vi.fn(() => Promise.resolve(json({ available: false })));
  vi.stubGlobal('fetch', fetch);
  fixture.render(
    <ManagerUpdateProgressDialog
      {...props}
      operation={null}
      requestError="Failed to fetch"
    />,
  );
  expect(
    await screen.findByText(
      'Le démarrage de l’opération n’est pas encore confirmé',
    ),
  ).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Impossible de confirmer la demande de mise à jour.',
  );
  expect(screen.queryByText('Opération en cours')).not.toBeInTheDocument();
  expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
});

it('keeps the journal during downtime and retrieves the final result without replaying the update', async () => {
  let value: ManagerStatus = response(operation);
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return Promise.resolve(json(value));
  });
  vi.stubGlobal('fetch', fetch);
  fixture.render(<ManagerUpdateProgressDialog {...props} />);
  const log = await screen.findByRole('log');
  expect(
    within(log).getByText('Sauvegarde des données', { exact: false }),
  ).toBeVisible();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  value = { ...value, available: false, update: undefined };
  await act(async () => {
    await fixture.queryClient.refetchQueries({
      queryKey: ['administration', 'manager-update-progress', 1],
    });
  });
  expect(
    await screen.findByText(/Le serveur est temporairement indisponible/),
  ).toBeVisible();
  expect(within(log).getAllByRole('listitem')).toHaveLength(2);
  value = response({
    ...operation,
    status: 'succeeded',
    phase: 'complete',
    backupRetained: true,
    events: [
      ...operation.events,
      { at: '2026-10-25T09:01:00Z', phase: 'complete', status: 'succeeded' },
    ],
  });
  await act(async () => {
    await fixture.queryClient.refetchQueries({
      queryKey: ['administration', 'manager-update-progress', 1],
    });
  });
  expect(await screen.findByText('Mise à jour réussie')).toBeVisible();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '6');
  expect(
    screen.queryByText(/Le serveur est temporairement indisponible/),
  ).not.toBeInTheDocument();
  expect(within(log).getAllByRole('listitem')).toHaveLength(3);
  expect(
    fetch.mock.calls.every(
      ([input, init]) =>
        input === '/api/settings/manager/status' && !init?.method,
    ),
  ).toBe(true);
});

it('retains progress without any protected request and blocks dismissal while session verification is unavailable', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const close = vi.fn();
  fixture.render(
    <ManagerUpdateProgressDialog
      {...props}
      onOpenChange={close}
      monitoringPaused
    />,
  );
  const dialog = await screen.findByRole('dialog');
  expect(screen.getByRole('log')).toHaveTextContent('Sauvegarde des données');
  expect(screen.getByText(/votre identité vérifiée/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Réduire' })).toBeDisabled();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('allows closing only once the operation has reached a terminal state', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        json(
          response({ ...operation, status: 'succeeded', phase: 'complete' }),
        ),
      ),
    ),
  );
  const close = vi.fn();
  fixture.render(
    <ManagerUpdateProgressDialog {...props} onOpenChange={close} />,
  );
  await screen.findByText('Mise à jour réussie');
  fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
  expect(close).toHaveBeenCalledWith(false);
});

it.each([
  ['rolledBack', 'complete', 'Version précédente restaurée'],
  [
    'recoveryRequired',
    'recoveryRequired',
    'La récupération nécessite une intervention',
  ],
] as const)(
  'does not confuse %s with a successful update',
  async (status, phase, label) => {
    const current = {
      ...operation,
      status,
      phase,
      error: 'updateHealthCheckFailed',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(response(current)))),
    );
    fixture.render(
      <ManagerUpdateProgressDialog {...props} operation={current} />,
    );
    expect(
      (await screen.findAllByText(label, { exact: false }))[0],
    ).toBeVisible();
    expect(screen.queryByText('Mise à jour réussie')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Un service n’a pas passé son contrôle de santé.',
    );
    expect(screen.getByRole('progressbar')).not.toHaveAttribute(
      'aria-valuenow',
      '6',
    );
  },
);

it('waits for the start request and excludes the preceding operation from the journal', async () => {
  const fetch = vi.fn(() =>
    Promise.resolve(
      json(
        response({
          ...operation,
          id: 'previous',
          status: 'succeeded',
          phase: 'complete',
        }),
      ),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  const view = fixture.render(
    <ManagerUpdateProgressDialog
      {...props}
      operation={null}
      pending
      excludedOperationId="previous"
    />,
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByRole('log')).toHaveTextContent('En attente du journal');
  view.rerender(
    <QueryClientProvider client={fixture.queryClient}>
      <ManagerUpdateProgressDialog
        {...props}
        operation={null}
        excludedOperationId="previous"
      />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('Mise à jour réussie')).not.toBeInTheDocument();
  expect(screen.getByRole('log')).toHaveTextContent('En attente du journal');
});

it('unlocks an incomplete historical monitor only after another operation is terminal and the Manager is idle', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        json(
          response({
            ...operation,
            id: 'newer-operation',
            status: 'succeeded',
            phase: 'complete',
          }),
        ),
      ),
    ),
  );
  fixture.render(<ManagerUpdateProgressDialog {...props} />);
  expect(
    await screen.findByText('Ce suivi n’est plus l’opération courante'),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Fermer' })).toBeEnabled();
  expect(screen.queryByText('Mise à jour réussie')).not.toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});

it('keeps an incomplete historical monitor locked while a newer operation is active', async () => {
  const fetch = vi.fn(() =>
    Promise.resolve(json(response({ ...operation, id: 'newer-operation' }))),
  );
  vi.stubGlobal('fetch', fetch);
  fixture.render(<ManagerUpdateProgressDialog {...props} />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: 'Réduire' })).toBeDisabled();
  expect(
    screen.queryByText('Ce suivi n’est plus l’opération courante'),
  ).not.toBeInTheDocument();
});

it('uses only the independent phase/journal while the normal API is stale, unavailable or identity verification is paused', async () => {
  const current = {
    ...operation,
    phase: 'managerReplacing',
    events: [
      ...operation.events,
      {
        at: '2026-10-25T09:01:00Z',
        phase: 'managerReplacing',
        status: 'running',
      },
    ],
  };
  let snapshot: unknown = {
    observedAt: '2026-10-25T09:01:00Z',
    operation: current,
  };
  let unavailable = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    if (input === '/_mergeron-update/status') {
      if (unavailable) throw new TypeError('network unavailable');
      return json(snapshot);
    }
    return json(response({ ...operation, phase: 'preparing', events: [] }));
  });
  vi.stubGlobal('fetch', fetcher);
  fixture.render(
    <ManagerUpdateProgressDialog {...props} independent monitoringPaused />,
  );
  expect(
    await screen.findByRole('heading', { name: 'Remplacement du Manager' }),
  ).toBeVisible();
  expect(screen.getAllByRole('log')).toHaveLength(1);
  expect(document.querySelector('iframe')).toBeNull();
  expect(within(screen.getByRole('log')).getAllByRole('listitem')).toHaveLength(
    3,
  );
  expect(
    fetcher.mock.calls.every(([url]) => url === '/_mergeron-update/status'),
  ).toBe(true);
  unavailable = true;
  await act(async () => {
    await fixture.queryClient.refetchQueries({
      queryKey: ['administration', 'independent-update-progress', 1],
    });
  });
  expect(
    screen.getByRole('heading', { name: 'Remplacement du Manager' }),
  ).toBeVisible();
  expect(
    (await screen.findAllByText(/Connexion au suivi interrompue/)).length,
  ).toBeGreaterThan(0);
  expect(screen.getByText(/Dernière donnée reçue à/)).toHaveTextContent(
    new Date('2026-10-25T09:01:00Z').toLocaleTimeString('fr'),
  );
  unavailable = false;
  snapshot = {
    observedAt: '2026-10-25T09:02:00Z',
    operation: { ...current, phase: 'complete', status: 'rolledBack' },
  };
  await act(async () => {
    await fixture.queryClient.refetchQueries({
      queryKey: ['administration', 'independent-update-progress', 1],
    });
  });
  expect(
    await screen.findByRole('heading', {
      name: 'Version précédente restaurée',
    }),
  ).toBeVisible();
  expect(screen.queryByText('Mise à jour réussie')).not.toBeInTheDocument();
});

it('does not replace a pinned independent operation with another journal', async () => {
  let current = { ...operation };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      input === '/_mergeron-update/status'
        ? json({ observedAt: '2026-10-25T09:01:00Z', operation: current })
        : json(response(operation)),
    ),
  );
  fixture.render(<ManagerUpdateProgressDialog {...props} independent />);
  await screen.findByText(/Suivi indépendant connecté/);
  current = {
    ...operation,
    id: 'another-operation',
    phase: 'complete',
    status: 'succeeded',
    events: [],
  };
  await act(async () => {
    await fixture.queryClient.refetchQueries({
      queryKey: ['administration', 'independent-update-progress', 1],
    });
  });
  expect(screen.getByRole('log')).toHaveTextContent('Sauvegarde des données');
  expect(screen.queryByText('Mise à jour réussie')).not.toBeInTheDocument();
  expect(
    (await screen.findAllByText(/Une autre opération est courante/)).length,
  ).toBeGreaterThan(0);
});

it('reduces a running monitor without closing or clearing its recovery receipt', async () => {
  const { saveManagerUpdateReceipt, readManagerUpdateReceipt } =
    await import('./manager-update-recovery');
  const session = Date.now();
  saveManagerUpdateReceipt({
    startedAt: session,
    operationId: operation.id,
    excludedOperationId: null,
    independentMonitor: true,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(response(operation))),
  );
  const minimize = vi.fn(),
    close = vi.fn();
  fixture.render(
    <ManagerUpdateProgressDialog
      {...props}
      session={session}
      onMinimize={minimize}
      onOpenChange={close}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Réduire' }));
  expect(minimize).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  expect(readManagerUpdateReceipt()?.operationId).toBe(operation.id);
  saveManagerUpdateReceipt(null);
});

it('never claims a preparation phase while waiting for the first independent journal', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      input === '/_mergeron-update/status'
        ? json({ observedAt: '2026-10-25T09:00:00Z', operation: null })
        : json({ available: false }),
    ),
  );
  fixture.render(
    <ManagerUpdateProgressDialog {...props} independent operation={null} />,
  );
  await screen.findByText('Suivi indépendant connecté');
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByText('Opération en cours')).not.toBeInTheDocument();
});

it('does not let a stale API completion override an ongoing independent Manager replacement', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      input === '/_mergeron-update/status'
        ? json({
            observedAt: '2026-10-25T09:01:00Z',
            operation: { ...operation, phase: 'managerReplacing' },
          })
        : json(
            response({ ...operation, status: 'succeeded', phase: 'complete' }),
          ),
    ),
  );
  fixture.render(<ManagerUpdateProgressDialog {...props} independent />);
  await screen.findByRole('heading', { name: 'Remplacement du Manager' });
  expect(screen.queryByText('Mise à jour réussie')).toBeNull();
  expect(screen.getAllByRole('log')).toHaveLength(1);
  expect(screen.getByRole('progressbar')).not.toHaveAttribute(
    'aria-valuenow',
    '9',
  );
});

it('does not flash a stale API success before receiving the first independent observation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      input === '/_mergeron-update/status'
        ? new Response('{}', { status: 503 })
        : json(
            response({ ...operation, status: 'succeeded', phase: 'complete' }),
          ),
    ),
  );
  fixture.render(
    <ManagerUpdateProgressDialog
      {...props}
      operation={{ ...operation, status: 'succeeded', phase: 'complete' }}
      independent
    />,
  );
  await screen.findByText(/Connexion au suivi interrompue/);
  expect(screen.queryByText('Mise à jour réussie')).toBeNull();
  expect(screen.queryByRole('progressbar')).toBeNull();
});

it('labels application completion as intermediate while the independent Manager verification is pending', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      input === '/_mergeron-update/status'
        ? json({
            observedAt: '2026-10-25T09:01:00Z',
            operation: {
              ...operation,
              phase: 'managerPending',
              events: [
                {
                  at: '2026-10-25T09:01:00Z',
                  phase: 'complete',
                  status: 'succeeded',
                },
              ],
            },
          })
        : json({ available: false }),
    ),
  );
  fixture.render(<ManagerUpdateProgressDialog {...props} independent />);
  expect(
    await screen.findByText(
      'Application mise à jour — vérification du Manager à suivre',
    ),
  ).toBeVisible();
  expect(screen.queryByText('Mise à jour réussie')).toBeNull();
});

it('continues read-only independent monitoring while minimized and reports its terminal state', async () => {
  let current = { ...operation };
  const fetcher = vi.fn(async (input: RequestInfo | URL) =>
    input === '/_mergeron-update/status'
      ? json({ observedAt: '2026-10-25T09:01:00Z', operation: current })
      : json({ available: false }),
  );
  vi.stubGlobal('fetch', fetcher);
  const active = vi.fn();
  fixture.render(
    <ManagerUpdateProgressDialog
      {...props}
      open={false}
      independent
      monitoringPaused
      monitorInBackground
      onRunningChange={active}
    />,
  );
  await waitFor(() => expect(active).toHaveBeenCalledWith(true));
  await waitFor(() =>
    expect(
      fixture.queryClient.getQueryData([
        'administration',
        'independent-update-progress',
        1,
        operation.id,
        null,
      ]),
    ).toBeDefined(),
  );
  current = { ...operation, status: 'succeeded', phase: 'complete' };
  await act(async () => {
    await fixture.queryClient.refetchQueries({
      queryKey: ['administration', 'independent-update-progress', 1],
    });
  });
  await waitFor(() => expect(active).toHaveBeenLastCalledWith(false));
  expect(
    fetcher.mock.calls.every(([url]) => url === '/_mergeron-update/status'),
  ).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
});
