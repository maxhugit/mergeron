import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GitLocalBranchActions } from './git-local-branch-actions';
import type { GitSnapshot } from '@/lib/workspace-git-api';
import i18n from '@/i18n';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({
  projectsApi: api,
  projectsQueryKey: ['projects'],
}));
const branch = {
  name: 'feature',
  revision: 'b'.repeat(40),
  remote: false,
  upstream: '',
  tracking: '',
};
const snapshot: GitSnapshot = {
  fingerprint: 'reviewed',
  head: 'a'.repeat(40),
  branch: 'main',
  changes: [],
  branches: [branch],
  ahead: 0,
  behind: 0,
  upstream: null,
  inspectedAt: 1,
  branchesLimited: false,
};
beforeEach(async () => {
  api.mockReset();
  api.mockResolvedValue({});
  await i18n.changeLanguage('fr');
});
afterEach(cleanup);
function show(state = snapshot, readOnly = false) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <GitLocalBranchActions
        projectId="p"
        copyId="copy"
        snapshot={state}
        branch={branch}
        agentThreadId="agent"
        readOnly={readOnly}
      />
    </QueryClientProvider>,
  );
}
async function openMenu() {
  fireEvent.pointerDown(
    screen.getByRole('button', { name: 'Actions de la branche feature' }),
    { button: 0, ctrlKey: false },
  );
  return screen.findByRole('menu');
}
async function choose(label: string) {
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
}
it.each([
  ['Changer de branche…', 'switch'],
  ['Fusionner dans la branche actuelle…', 'merge'],
  ['Supprimer la branche locale…', 'delete'],
])(
  'confirms %s with pinned source and reviewed state',
  async (label, action) => {
    show();
    expect(screen.queryByRole('button', { name: label })).toBeNull();
    await choose(label);
    expect(api).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent(
      action === 'delete'
        ? 'feature'
        : action === 'switch'
          ? 'main → feature'
          : 'feature → main',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
    await waitFor(() => expect(api).toHaveBeenCalledOnce());
    const [url, options] = api.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/p/git/copies/copy/branch-action');
    expect(JSON.parse(options.body)).toMatchObject({
      action,
      name: 'feature',
      revision: branch.revision,
      fingerprint: 'reviewed',
      agentThreadId: 'agent',
      confirmation:
        action === 'delete' ? 'DELETE_LOCAL_BRANCH' : 'LOCAL_BRANCH_ACTION',
    });
  },
);
it('disables operations for dirty and read-only copies', async () => {
  show({ ...snapshot, changes: [{ path: 'file', status: '??' }] });
  await openMenu();
  expect(
    screen.getByRole('menuitem', { name: /Changer de branche…/ }),
  ).toHaveAttribute('aria-disabled', 'true');
  cleanup();
  show(snapshot, true);
  await openMenu();
  expect(
    screen.getByRole('menuitem', {
      name: 'Fusionner dans la branche actuelle…',
    }),
  ).toHaveAttribute('aria-disabled', 'true');
});
it('does not offer deletion for the current branch', () => {
  show({ ...snapshot, branch: branch.name });
  expect(
    screen.queryByRole('button', { name: 'Actions de la branche feature' }),
  ).toBeNull();
});
it('explains unmerged commits and keeps the confirmation open on refusal', async () => {
  api.mockRejectedValue(new Error('GIT_BRANCH_UNMERGED'));
  show();
  await choose('Supprimer la branche locale…');
  expect(screen.getByRole('dialog')).toHaveTextContent(
    'Aucun fichier ni branche distante',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Fusionnez-la d’abord',
  );
  expect(screen.getByRole('dialog')).toBeVisible();
});
it('shows the localized refusal without retrying', async () => {
  api.mockRejectedValue(new Error('GIT_LOCAL_MERGE_CONFLICT'));
  show();
  await choose('Fusionner dans la branche actuelle…');
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Aucun fichier');
  expect(api).toHaveBeenCalledOnce();
});
