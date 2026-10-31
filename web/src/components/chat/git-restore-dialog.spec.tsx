import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GitRestoreDialog } from './git-restore-dialog';
import i18n from '@/i18n';
import type { GitSnapshot } from '@/lib/workspace-git-api';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
const snapshot: GitSnapshot = {
  head: 'a'.repeat(40),
  branch: 'work',
  fingerprint: 'b'.repeat(64),
  changes: [{ path: 'README.md', status: 'MM' }],
  branches: [],
  inspectedAt: 1,
  ahead: 0,
  behind: 0,
  upstream: null,
  branchesLimited: false,
};
const plan = {
  branch: 'work',
  head: snapshot.head,
  revision: 'c'.repeat(40),
  reviewFingerprint: 'd'.repeat(64),
  paths: ['README.md'],
  fileCount: 1,
  limited: false,
  localCommits: 1,
  preservedUntracked: 1,
};
const outcome = {
  restored: true,
  backupBranch: 'mergeron-backup/test',
  backupRevision: 'e'.repeat(40),
};
let client: QueryClient;
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  api
    .mockReset()
    .mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/branches')
          ? {
              supported: true,
              items: [{ name: 'main', revision: plan.revision }],
            }
          : url.endsWith('restore-review')
            ? plan
            : outcome,
      ),
    );
});
afterEach(() => client.clear());
function show(target: 'head' | 'github' = 'head', onClose = vi.fn()) {
  return render(
    <QueryClientProvider client={client}>
      <GitRestoreDialog
        projectId="p"
        copyId="copy"
        resourceId="git"
        agentThreadId="agent"
        address="https://github.com/example/demo.git"
        snapshot={snapshot}
        target={target}
        paths={target === 'head' ? ['README.md'] : undefined}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
}
const writes = () =>
  api.mock.calls
    .filter(([, options]) => options?.method === 'POST')
    .map(([url, options]) => ({
      url,
      body: JSON.parse(options.body as string),
    }));
async function inspect() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Examiner l’état à restaurer' }),
  );
  await screen.findByRole('checkbox');
}
it('does not even review or mutate a file when cancelled', () => {
  const close = vi.fn();
  show('head', close);
  expect(screen.getByText('README.md')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(writes()).toEqual([]);
});
it('requires an unchanged review and explicit acknowledgement, submits once and keeps the recovery branch visible', async () => {
  show();
  await inspect();
  const confirm = screen.getByRole('button', {
    name: 'Confirmer le remplacement',
  });
  expect(confirm).toBeDisabled();
  expect(writes()).toHaveLength(1);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(await screen.findByRole('status')).toHaveTextContent(
    'GitHub n’a pas été modifié',
  );
  expect(screen.getByText(outcome.backupBranch)).toBeVisible();
  expect(writes()).toEqual([
    {
      url: '/p/git/copies/copy/restore-review',
      body: {
        fingerprint: snapshot.fingerprint,
        agentThreadId: 'agent',
        target: 'head',
        paths: ['README.md'],
      },
    },
    {
      url: '/p/git/copies/copy/restore',
      body: {
        fingerprint: snapshot.fingerprint,
        agentThreadId: 'agent',
        target: 'head',
        paths: ['README.md'],
        reviewFingerprint: plan.reviewFingerprint,
        confirmation: 'RESTORE_LOCAL_FILES',
      },
    },
  ]);
});
it('requires a deliberate GitHub branch selection and pins that observed SHA, not a mutable origin or implicit main', async () => {
  show('github');
  const select = screen.getByRole('combobox', {
    name: 'Branche GitHub source',
  });
  await screen.findByRole('option', { name: /main · ccccccc/ });
  expect(select).toHaveValue('');
  expect(
    screen.getByRole('button', { name: 'Examiner l’état à restaurer' }),
  ).toBeDisabled();
  fireEvent.change(select, { target: { value: 'main' } });
  await inspect();
  expect(select).toBeDisabled();
  expect(
    screen.getByText(/Commits locaux absents de la cible/),
  ).toHaveTextContent('1');
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Confirmer le remplacement' }),
  );
  await screen.findByRole('status');
  expect(writes()[1].body).toMatchObject({
    target: 'github',
    name: 'main',
    revision: plan.revision,
    confirmation: 'RESTORE_GITHUB_STATE',
  });
  expect(
    writes().some((request) => /push|integrate|commit$/.test(request.url)),
  ).toBe(false);
});
it('retains recovery information for a partial operation and never retries it', async () => {
  api.mockImplementation((url: string) =>
    Promise.resolve(
      url.endsWith('restore-review')
        ? plan
        : { ...outcome, restored: false, reason: 'GIT_RESTORE_INCOMPLETE' },
    ),
  );
  show();
  await inspect();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Confirmer le remplacement' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Ne relancez pas automatiquement',
  );
  expect(screen.getByText(outcome.backupBranch)).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Confirmer le remplacement' }),
  ).toBeNull();
  await waitFor(() => expect(writes()).toHaveLength(2));
});
