import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GitRemoteBranchMenu } from './git-remote-branch-menu';
import type { GitSnapshot } from '@/lib/workspace-git-api';
import type { ProjectWorkspaceCopySummary } from '@/lib/projects-api';
import i18n from '@/i18n';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({
  projectsApi: api,
  projectsQueryKey: ['projects'],
}));
const copy: ProjectWorkspaceCopySummary = {
  id: 'copy',
  projectId: 'p',
  sourceResourceId: 'git',
  localWorkspaceId: 'local',
  branch: 'main',
  revision: 'a'.repeat(40),
  sourceName: 'Git Test',
  sourceType: 'git',
  lastError: null,
  name: 'Git Test',
  localPath: '/copy',
  accessMode: 'read_write',
  state: 'ready',
  sourceEnabled: true,
  createdAt: 1,
  updatedAt: 1,
};
const snapshot: GitSnapshot = {
  fingerprint: 'reviewed',
  branch: 'main',
  head: 'a'.repeat(40),
  changes: [{ path: 'keep.md', status: ' M' }],
  branches: [],
  ahead: 0,
  behind: 0,
  upstream: null,
  inspectedAt: 1,
  branchesLimited: false,
};
beforeEach(async () => {
  api.mockReset();
  api.mockResolvedValue({ branch: 'dev' });
  await i18n.changeLanguage('fr');
});
afterEach(cleanup);
function fixture(
  overrides: Partial<React.ComponentProps<typeof GitRemoteBranchMenu>> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const props = {
    projectId: 'p',
    resourceId: 'git',
    address: 'https://github.com/example/demo.git',
    branch: 'dev',
    revision: 'b'.repeat(40),
    copy,
    snapshot,
    canWrite: true,
    agentThreadId: 'agent',
    canPrepare: false,
    onPrepare: vi.fn(),
    ...overrides,
  };
  const element = (next = props) => (
    <QueryClientProvider client={client}>
      <GitRemoteBranchMenu {...next} />
    </QueryClientProvider>
  );
  return { ...render(element()), client, props, element };
}
async function menu() {
  fireEvent.pointerDown(
    screen.getByRole('button', { name: 'Actions de la branche distante dev' }),
    { button: 0, ctrlKey: false },
  );
  return screen.findByRole('menu');
}
async function review() {
  await menu();
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Récupérer cette branche en local…' }),
  );
}
it('does not fetch until confirmation and pins revision, source, copy and state while preserving pending work', async () => {
  const { client } = fixture();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  await review();
  expect(api).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toHaveTextContent(
    'Copie locale : Git Test',
  );
  expect(screen.getByRole('dialog')).toHaveTextContent(
    'Branche active conservée : main',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Récupérer la branche' }));
  await waitFor(() => expect(api).toHaveBeenCalledOnce());
  const [url, options] = api.mock.calls[0] as [string, { body: string }];
  expect(url).toBe('/p/git/copies/copy/retrieve-branch');
  expect(JSON.parse(options.body)).toMatchObject({
    name: 'dev',
    revision: 'b'.repeat(40),
    address: 'https://github.com/example/demo.git',
    fingerprint: 'reviewed',
    agentThreadId: 'agent',
    confirmation: 'RETRIEVE_REMOTE_BRANCH',
  });
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['workspace-git', 'p', 'copy'],
    }),
  );
});
it.each(['existing', 'no-copy', 'read-only'] as const)(
  'disables retrieval for %s',
  async (kind) => {
    fixture(
      kind === 'existing'
        ? {
            snapshot: {
              ...snapshot,
              branches: [
                {
                  name: 'dev',
                  revision: 'c'.repeat(40),
                  remote: false,
                  upstream: '',
                  tracking: '',
                },
              ],
            },
          }
        : kind === 'no-copy'
          ? { copy: undefined }
          : { canWrite: false },
    );
    await menu();
    expect(
      screen.getByRole('menuitem', {
        name: /Récupérer cette branche en local/,
      }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(api).not.toHaveBeenCalled();
  },
);
it('cancels without sending any request', async () => {
  fixture();
  await review();
  fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
  expect(api).not.toHaveBeenCalled();
});
it('disables stale confirmation after the remote revision changes', async () => {
  const view = fixture();
  await review();
  view.rerender(view.element({ ...view.props, revision: 'c'.repeat(40) }));
  expect(
    screen.getByRole('button', { name: 'Récupérer la branche' }),
  ).toBeDisabled();
});
it('reports existing-branch refusal without retrying', async () => {
  api.mockRejectedValue(new Error('GIT_BRANCH_EXISTS'));
  fixture();
  await review();
  fireEvent.click(screen.getByRole('button', { name: 'Récupérer la branche' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'porte déjà ce nom',
  );
  expect(api).toHaveBeenCalledOnce();
});
