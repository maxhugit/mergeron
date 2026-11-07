import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { ProjectIntegritySettings } from './project-integrity-settings';
import {
  integrityRequest,
  type IntegrityReport,
} from './project-integrity-api';
const session = vi.hoisted(() => ({ isAdministrator: true }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => session,
}));
vi.mock('./project-integrity-api', () => ({ integrityRequest: vi.fn() }));
let client: QueryClient;
let report: IntegrityReport;
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  session.isAdministrator = true;
  report = {
    projectId: 'p',
    name: 'Project',
    root: '/workspaces/p',
    inspectedAt: 1,
    fingerprint: 'fresh',
    limited: false,
    counts: { documents: 1, versions: 2, copies: 0 },
    issues: [
      {
        id: 'missing',
        kind: 'directory-missing',
        path: '/workspaces/p/dossiers',
        severity: 'error',
        action: 'create-directory',
      },
    ],
  };
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.mocked(integrityRequest)
    .mockReset()
    .mockImplementation(async (p = '', body) =>
      p === ''
        ? { projects: [{ id: 'p', name: 'Project' }] }
        : body
          ? { ...report, issues: [] }
          : report,
    );
});
afterEach(() => {
  cleanup();
  client.clear();
});
function show() {
  return render(
    <QueryClientProvider client={client}>
      <ProjectIntegritySettings />
    </QueryClientProvider>,
  );
}
async function choose() {
  await screen.findByRole('option', { name: 'Project' });
  fireEvent.change(await screen.findByRole('combobox'), {
    target: { value: 'p' },
  });
  await screen.findByText('Un dossier de rangement est absent');
}
async function openCorrections() {
  fireEvent.click(
    await screen.findByRole('button', { name: /^Corrections :/ }),
  );
  await screen.findByRole('dialog');
}
it('requires explicit confirmation and uses the server fingerprint, never a client path', async () => {
  show();
  await choose();
  await openCorrections();
  fireEvent.click(
    screen.getByRole('button', { name: 'Recréer ce dossier vide' }),
  );
  expect(
    vi.mocked(integrityRequest).mock.calls.some(([, body]) => !!body),
  ).toBe(false);
  fireEvent.click(
    screen.getByRole('button', { name: 'Appliquer la correction' }),
  );
  await screen.findByText(
    'Aucune incohérence détectée dans le périmètre contrôlé.',
  );
  expect(integrityRequest).toHaveBeenCalledWith('/p/repair', {
    fingerprint: 'fresh',
    issueId: 'missing',
    confirmation: 'REPAIR_PROJECT',
  });
});
it('does not apply a cancelled correction', async () => {
  show();
  await choose();
  await openCorrections();
  fireEvent.click(
    screen.getByRole('button', { name: 'Recréer ce dossier vide' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(
    vi.mocked(integrityRequest).mock.calls.some(([, body]) => !!body),
  ).toBe(false);
});
it('reports a stale plan and re-reads the project instead of retrying the write', async () => {
  vi.mocked(integrityRequest).mockImplementation(async (p = '', body) => {
    if (body) throw new Error('changed');
    return p === '' ? { projects: [{ id: 'p', name: 'Project' }] } : report;
  });
  show();
  await choose();
  await openCorrections();
  fireEvent.click(
    screen.getByRole('button', { name: 'Recréer ce dossier vide' }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Appliquer la correction' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Le diagnostic a changé',
  );
  expect(
    vi.mocked(integrityRequest).mock.calls.filter(([, body]) => !!body),
  ).toHaveLength(1);
});
it('does not fetch any project metadata for a non-administrator', async () => {
  session.isAdministrator = false;
  show();
  expect(screen.getByRole('alert')).toHaveTextContent('administrateurs');
  await act(async () => {});
  expect(integrityRequest).not.toHaveBeenCalled();
});
it('never presents a failed inspection as healthy', async () => {
  vi.mocked(integrityRequest).mockImplementation(async (p = '') => {
    if (p) throw new Error('failed');
    return { projects: [{ id: 'p', name: 'Project' }] };
  });
  show();
  await screen.findByRole('option', { name: 'Project' });
  fireEvent.change(await screen.findByRole('combobox'), {
    target: { value: 'p' },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Aucune conclusion',
  );
  expect(
    screen.queryByText(
      'Aucune incohérence détectée dans le périmètre contrôlé.',
    ),
  ).toBeNull();
});

it('identifies the affected task and confirms its new reference from the diagnostic', async () => {
  report.issues = [
    {
      id: 'ref',
      kind: 'active-folder-registration-missing',
      path: report.root,
      severity: 'warning',
      action: 'select-project-folder',
      expectedPath: report.root + '/dossiers',
      reference: {
        contextType: 'task',
        contextId: 'task-1',
        label: 'Préparer la réunion',
        resourceId: 'removed',
        relativePath: '',
      },
    },
  ];
  show();
  await screen.findByRole('option', { name: 'Project' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p' } });
  await screen.findByText('Tâche : Préparer la réunion');
  expect(screen.queryByText('Connexion absente : removed')).toBeNull();
  await openCorrections();
  fireEvent.click(screen.getByText('Détails techniques'));
  expect(screen.getByText('Connexion absente : removed')).toBeVisible();
  fireEvent.click(
    screen.getByRole('button', { name: 'Utiliser Dossiers comme référence…' }),
  );
  expect(vi.mocked(integrityRequest).mock.calls.some(([, b]) => !!b)).toBe(
    false,
  );
  expect(screen.getAllByText('/workspaces/p/dossiers').length).toBeGreaterThan(
    0,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Appliquer la correction' }),
  );
  await waitFor(() =>
    expect(integrityRequest).toHaveBeenCalledWith('/p/repair', {
      fingerprint: 'fresh',
      issueId: 'ref',
      confirmation: 'REPAIR_PROJECT',
    }),
  );
});

it('opens guidance for an issue without a supported automatic repair and refreshes without writing', async () => {
  report.issues[0].action = null;
  show();
  await choose();
  await openCorrections();
  const dialog = screen.getByRole('dialog');
  expect(
    within(dialog).getByText(/Aucune correction automatique n’est disponible/),
  ).toBeInTheDocument();
  expect(
    within(dialog).queryByRole('button', { name: 'Recréer ce dossier vide' }),
  ).toBeNull();
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Actualiser le diagnostic' }),
  );
  await waitFor(() =>
    expect(
      vi.mocked(integrityRequest).mock.calls.filter(([p]) => p === '/p'),
    ).toHaveLength(2),
  );
  expect(
    vi.mocked(integrityRequest).mock.calls.some(([, body]) => !!body),
  ).toBe(false);
});

it('shows that a selected issue has disappeared after a refreshed inspection', async () => {
  show();
  await choose();
  await openCorrections();
  vi.mocked(integrityRequest).mockResolvedValue({ ...report, issues: [] });
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Actualiser le diagnostic',
    }),
  );
  expect(
    await screen.findByText(
      'Cette anomalie n’apparaît plus dans le diagnostic actualisé.',
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Recréer ce dossier vide' }),
  ).toBeNull();
  expect(
    vi.mocked(integrityRequest).mock.calls.some(([, body]) => !!body),
  ).toBe(false);
});

it.each([
  'create-directory',
  'realign-agent',
  'realign-override',
  'select-project-folder',
] as const)(
  'offers only the server-supported correction %s and confirms its exact issue',
  async (action) => {
    report.issues[0].action = action;
    show();
    await choose();
    await openCorrections();
    const label =
      action === 'create-directory'
        ? 'Recréer ce dossier vide'
        : action === 'select-project-folder'
          ? 'Utiliser Dossiers comme référence…'
          : 'Réaligner cette référence';
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: label }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(
      vi.mocked(integrityRequest).mock.calls.some(([, body]) => !!body),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole('button', { name: 'Appliquer la correction' }),
    );
    await waitFor(() =>
      expect(integrityRequest).toHaveBeenCalledWith('/p/repair', {
        fingerprint: 'fresh',
        issueId: 'missing',
        confirmation: 'REPAIR_PROJECT',
      }),
    );
  },
);

it('does not offer automatic writes from an incomplete inspection', async () => {
  report.limited = true;
  show();
  await choose();
  await openCorrections();
  expect(
    within(screen.getByRole('dialog')).queryByRole('button', {
      name: 'Recréer ce dossier vide',
    }),
  ).toBeNull();
  expect(
    screen.getByText(/Aucune correction automatique n’est disponible/),
  ).toBeInTheDocument();
});

it('offers opening the affected agent to choose its reference, without a repair request', async () => {
  report.issues[0].action = null;
  report.issues[0].reference = {
    contextType: 'agent',
    contextId: 'agent-1',
    label: 'Agent exemple',
    resourceId: 'gone',
    relativePath: '',
  };
  show();
  await choose();
  await openCorrections();
  expect(
    within(screen.getByRole('dialog')).getByRole('link', {
      name: 'Ouvrir l’agent pour choisir une autre référence',
    }),
  ).toHaveAttribute('href', '/t/agent-1');
  expect(
    vi.mocked(integrityRequest).mock.calls.some(([, body]) => !!body),
  ).toBe(false);
});

it('previews a repair without writing, keeps technical details collapsed, and still requires confirmation', async () => {
  show();
  await choose();
  await openCorrections();
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('img')).toHaveAccessibleName(
    /Dossier attendu/,
  );
  expect(
    within(dialog).getByText('Détails techniques').closest('details'),
  ).not.toHaveAttribute('open');
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Après correction' }),
  );
  expect(within(dialog).getByRole('img')).toHaveAccessibleName(
    /Dossier créé — Dossier vide/,
  );
  expect(within(dialog).getByRole('status')).toHaveTextContent(
    'Aucune correction n’a encore été appliquée',
  );
  expect(
    vi.mocked(integrityRequest).mock.calls.some(([, body]) => !!body),
  ).toBe(false);
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Situation actuelle' }),
  );
  expect(within(dialog).getByRole('img')).toHaveAccessibleName(/Absent/);
});
it('does not offer an after preview for manual, unknown, or incomplete diagnoses', async () => {
  report.limited = true;
  show();
  await choose();
  await openCorrections();
  expect(screen.queryByRole('button', { name: 'Après correction' })).toBeNull();
  expect(screen.queryByText('Dossier créé')).toBeNull();
  expect(
    vi.mocked(integrityRequest).mock.calls.some(([, body]) => !!body),
  ).toBe(false);
});
it('revokes the visual preview if refreshed inspection no longer permits repair', async () => {
  show();
  await choose();
  await openCorrections();
  fireEvent.click(screen.getByRole('button', { name: 'Après correction' }));
  vi.mocked(integrityRequest).mockResolvedValue({ ...report, limited: true });
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Actualiser le diagnostic',
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Après correction' }),
    ).toBeNull(),
  );
  expect(
    within(screen.getByRole('dialog')).getByRole('img'),
  ).toHaveAccessibleName(/Absent/);
  expect(
    screen.queryByRole('button', { name: 'Recréer ce dossier vide' }),
  ).toBeNull();
});
