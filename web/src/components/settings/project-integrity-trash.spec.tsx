import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import {
  IntegrityTrashAction,
  ProjectIntegrityTrash,
} from './project-integrity-trash';
import {
  integrityRequest,
  type IntegrityReport,
  type IntegrityIssue,
} from './project-integrity-api';
vi.mock('./project-integrity-api', () => ({ integrityRequest: vi.fn() }));
let client: QueryClient;
const issue: IntegrityIssue = {
  id: 'orphan',
  kind: 'unregistered-document',
  path: '/workspaces/p/.mergeron-system/livrables/orphan.txt',
  severity: 'warning',
  action: null,
  trash: { name: 'orphan.txt' },
};
const report: IntegrityReport = {
  projectId: 'p',
  root: '/workspaces/p',
  name: 'p',
  fingerprint: 'reviewed',
  inspectedAt: 1,
  limited: false,
  issues: [issue],
  counts: { documents: 0, versions: 0, copies: 0 },
};
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.mocked(integrityRequest)
    .mockReset()
    .mockResolvedValue({ ...report, issues: [] });
});
afterEach(() => {
  cleanup();
  client.clear();
});
const show = (node: React.ReactNode) =>
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
it('requires the exact name and confirmation, never writes on opening or cancellation', async () => {
  show(<IntegrityTrashAction report={report} issue={issue} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Mettre ces données à la corbeille' }),
  );
  expect(integrityRequest).not.toHaveBeenCalled();
  const submit = screen
    .getAllByRole('button', { name: 'Mettre ces données à la corbeille' })
    .at(-1)!;
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'wrong' } });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
  expect(integrityRequest).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Mettre ces données à la corbeille' }),
  );
  expect(screen.getByRole('textbox')).toHaveValue('');
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'orphan.txt' },
  });
  fireEvent.click(
    screen
      .getAllByRole('button', { name: 'Mettre ces données à la corbeille' })
      .at(-1)!,
  );
  await waitFor(() =>
    expect(integrityRequest).toHaveBeenCalledWith('/p/trash', {
      fingerprint: 'reviewed',
      issueId: 'orphan',
      name: 'orphan.txt',
      confirmation: 'MOVE_TO_PROJECT_TRASH',
    }),
  );
});
it('retains the exact reviewed fingerprint if a refreshed report arrives during confirmation', async () => {
  const view = show(<IntegrityTrashAction report={report} issue={issue} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Mettre ces données à la corbeille' }),
  );
  view.rerender(
    <QueryClientProvider client={client}>
      <IntegrityTrashAction
        report={{ ...report, fingerprint: 'new' }}
        issue={issue}
      />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'orphan.txt' },
  });
  fireEvent.click(
    screen
      .getAllByRole('button', { name: 'Mettre ces données à la corbeille' })
      .at(-1)!,
  );
  await waitFor(() =>
    expect(integrityRequest).toHaveBeenCalledWith(
      '/p/trash',
      expect.objectContaining({ fingerprint: 'reviewed' }),
    ),
  );
});
it('never offers removal without a server capability or on an incomplete report', () => {
  const view = show(
    <IntegrityTrashAction
      report={report}
      issue={{ ...issue, trash: undefined }}
    />,
  );
  expect(screen.queryByRole('button')).toBeNull();
  view.rerender(
    <QueryClientProvider client={client}>
      <IntegrityTrashAction
        report={{ ...report, limited: true }}
        issue={issue}
      />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('button')).toBeNull();
});
it('requires an explicit recovery click and shows the new destination without overwriting a document', async () => {
  const entry = {
    id: 'entry',
    name: 'orphan.txt',
    originalPath: issue.path,
    createdAt: 1,
    actorName: 'Admin',
    kind: issue.kind,
  };
  vi.mocked(integrityRequest).mockImplementation(async (path) =>
    path?.endsWith('/recover')
      ? { path: '/workspaces/p/dossiers/orphan.recovered-uuid.txt' }
      : { entries: [entry] },
  );
  show(<ProjectIntegrityTrash projectId="p" />);
  await screen.findByText('Corbeille du projet (1)');
  fireEvent.click(screen.getByText('Corbeille du projet (1)'));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Récupérer dans Dossiers' }),
  );
  expect(
    vi.mocked(integrityRequest).mock.calls.every(([, body]) => !body),
  ).toBe(true);
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Récupérer dans Dossiers' }).at(-1)!,
  );
  expect(await screen.findByRole('status')).toHaveTextContent(
    '/workspaces/p/dossiers/orphan.recovered-uuid.txt',
  );
  expect(integrityRequest).toHaveBeenCalledWith('/p/trash/recover', {
    entryId: 'entry',
    confirmation: 'RECOVER_PROJECT_TRASH',
  });
});
