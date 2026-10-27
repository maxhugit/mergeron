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
it.each([
  ['Changer de branche…', 'switch'],
  ['Fusionner dans la branche actuelle…', 'merge'],
])(
  'confirms %s with pinned source and reviewed state',
  async (label, action) => {
    show();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(api).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent(
      action === 'switch' ? 'main → feature' : 'feature → main',
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
      confirmation: 'LOCAL_BRANCH_ACTION',
    });
  },
);
it('disables operations for dirty and read-only copies', () => {
  show({ ...snapshot, changes: [{ path: 'file', status: '??' }] });
  expect(
    screen.getByRole('button', { name: 'Changer de branche…' }),
  ).toBeDisabled();
  cleanup();
  show(snapshot, true);
  expect(
    screen.getByRole('button', { name: 'Fusionner dans la branche actuelle…' }),
  ).toBeDisabled();
});
it('shows the localized refusal without retrying', async () => {
  api.mockRejectedValue(new Error('GIT_LOCAL_MERGE_CONFLICT'));
  show();
  fireEvent.click(
    screen.getByRole('button', { name: 'Fusionner dans la branche actuelle…' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Aucun fichier');
  expect(api).toHaveBeenCalledOnce();
});
