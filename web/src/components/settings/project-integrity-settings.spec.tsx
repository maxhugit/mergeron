import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  await screen.findByText('Dossier attendu absent');
}
it('requires explicit confirmation and uses the server fingerprint, never a client path', async () => {
  show();
  await choose();
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
