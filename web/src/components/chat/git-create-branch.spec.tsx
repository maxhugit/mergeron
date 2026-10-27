import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GitCreateBranch } from './git-create-branch';
import type { GitSnapshot } from '@/lib/workspace-git-api';
import i18n from '@/i18n';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({
  projectsApi: api,
  projectsQueryKey: ['projects'],
}));
const snapshot: GitSnapshot = {
  fingerprint: 'fingerprint',
  branch: 'main',
  head: 'a'.repeat(40),
  ahead: 0,
  behind: 0,
  upstream: null,
  inspectedAt: 1,
  branchesLimited: false,
  changes: [],
  branches: [
    {
      name: 'origin/develop',
      revision: 'b'.repeat(40),
      remote: true,
      upstream: '',
      tracking: '',
    },
  ],
};
beforeEach(async () => {
  api.mockReset();
  api.mockResolvedValue({ branch: 'feature/test' });
  await i18n.changeLanguage('fr');
});
afterEach(cleanup);
function show(readOnly = false) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <GitCreateBranch
        projectId="p"
        copyId="copy"
        snapshot={snapshot}
        agentThreadId="agent"
        readOnly={readOnly}
      />
    </QueryClientProvider>,
  );
}
it('creates only after explicit confirmation with the chosen pinned starting point', async () => {
  show();
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Créer une branche' }));
  const dialog = screen.getByRole('dialog');
  expect(
    within(dialog).getByRole('button', { name: 'Créer une branche' }),
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Nom de la nouvelle branche'), {
    target: { value: 'feature/test' },
  });
  fireEvent.change(screen.getByLabelText('Point de départ'), {
    target: { value: 'refs/remotes/origin/develop' },
  });
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Créer une branche' }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/p/git/copies/copy/branches', {
      method: 'POST',
      body: JSON.stringify({
        name: 'feature/test',
        startRef: 'refs/remotes/origin/develop',
        startRevision: 'b'.repeat(40),
        checkout: true,
        fingerprint: 'fingerprint',
        agentThreadId: 'agent',
        confirmation: 'CREATE_LOCAL_BRANCH',
      }),
    }),
  );
  expect(await screen.findByRole('status')).toHaveTextContent(
    'créée et activée',
  );
  expect(api).toHaveBeenCalledOnce();
});
it('does not create on cancel and disables readonly copies', () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Créer une branche' }));
  fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
  expect(api).not.toHaveBeenCalled();
  cleanup();
  show(true);
  expect(
    screen.getByRole('button', { name: 'Créer une branche' }),
  ).toBeDisabled();
});
it('keeps errors visible without closing the form or retrying', async () => {
  api.mockRejectedValue(new Error('GIT_BRANCH_EXISTS'));
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Créer une branche' }));
  fireEvent.change(screen.getByLabelText('Nom de la nouvelle branche'), {
    target: { value: 'feature/test' },
  });
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Créer une branche',
    }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'porte déjà ce nom',
  );
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(api).toHaveBeenCalledOnce();
});
