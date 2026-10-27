import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GitCopyActions, GitMergeAction } from './workspace-git-actions';
import i18n from '@/i18n';
import type { GitSnapshot, GitChecks } from '@/lib/workspace-git-api';
const api = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({
  data: {
    kind: 'person' as 'person' | 'service',
    personId: 'person',
    active: true,
    name: 'Test Reviewer',
    email: 'test@example.invalid',
  },
  isError: false,
  isFetching: false,
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    ...session,
    isPending: false,
    refetch: vi.fn().mockResolvedValue({}),
  }),
}));
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
let client: QueryClient;
const snapshot: GitSnapshot = {
  fingerprint: 'a'.repeat(64),
  branch: 'feature',
  head: 'b'.repeat(40),
  changes: [
    { path: 'staged.ts', status: 'M ' },
    { path: 'unstaged.ts', status: ' M' },
  ],
  branches: [],
  ahead: 1,
  behind: 0,
  upstream: null,
  branchesLimited: false,
  inspectedAt: 1,
};
const checks: GitChecks = {
  head: 'c'.repeat(40),
  baseHead: 'd'.repeat(40),
  draft: false,
  mergeable: true,
  mergeableState: 'clean',
  limited: false,
  items: [{ id: 'build', name: 'build', status: 'success' }],
  inspectedAt: 1,
};
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  session.data = {
    kind: 'person',
    personId: 'person',
    active: true,
    name: 'Test Reviewer',
    email: 'test@example.invalid',
  };
  session.isError = false;
  session.isFetching = false;
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  api
    .mockReset()
    .mockImplementation(async (_url: string, options?: RequestInit) =>
      options?.method === 'POST'
        ? { sha: 'e'.repeat(40), merged: true }
        : { fingerprint: snapshot.fingerprint, diff: '+only-staged' },
    );
});
afterEach(() => client.clear());
const wrapper = ({ children }: { children: import('react').ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const posts = () =>
  api.mock.calls.filter(([, options]) => options?.method === 'POST');
const showCopy = (
  state = snapshot,
  address = 'https://github.com/example/demo.git',
) =>
  render(
    <GitCopyActions
      projectId="p"
      copyId="copy"
      snapshot={state}
      address={address}
    />,
    { wrapper },
  );
async function fillCommit() {
  fireEvent.change(screen.getByLabelText('Message du commit'), {
    target: { value: 'Reviewed change' },
  });
  expect(screen.getByLabelText('Nom de l’auteur')).toHaveValue('Test Reviewer');
  expect(screen.getByLabelText('Nom de l’auteur')).toHaveAttribute('readonly');
  expect(screen.getByLabelText('E-mail de l’auteur')).toHaveValue(
    'test@example.invalid',
  );
  expect(screen.getByLabelText('E-mail de l’auteur')).toHaveAttribute(
    'readonly',
  );
  await screen.findByText('+only-staged');
}

it('allows an explicit first staged commit but disables push before HEAD exists', () => {
  showCopy({ ...snapshot, head: '' });
  expect(screen.getByRole('button', { name: 'Commit…' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Push…' })).toBeDisabled();
});
it('requires staged review, identity and explicit commit confirmation', async () => {
  showCopy();
  fireEvent.click(screen.getByRole('button', { name: 'Commit…' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('M · staged.ts')).toBeInTheDocument();
  expect(within(dialog).queryByText('unstaged.ts')).not.toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Confirmer le commit' }),
  ).toBeDisabled();
  expect(posts()).toHaveLength(0);
  await fillCommit();
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer le commit' }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  const body = JSON.parse(posts()[0][1].body as string);
  expect(body).toMatchObject({
    fingerprint: snapshot.fingerprint,
    message: 'Reviewed change',
  });
  expect(body).not.toHaveProperty('authorName');
  expect(body).not.toHaveProperty('authorEmail');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
it('blocks committing when the staged preview no longer matches the reviewed index', async () => {
  api.mockResolvedValue({ fingerprint: 'changed', diff: 'other changes' });
  showCopy();
  fireEvent.click(screen.getByRole('button', { name: 'Commit…' }));
  await fillCommit().catch(() => undefined);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'L’état Git a changé',
  );
  expect(
    screen.getByRole('button', { name: 'Confirmer le commit' }),
  ).toBeDisabled();
  expect(posts()).toHaveLength(0);
});

it.each(['missing-email', 'service', 'session-error', 'refreshing'])(
  'blocks commit for an unavailable connected identity: %s',
  async (mode) => {
    if (mode === 'missing-email') session.data.email = '';
    if (mode === 'service') session.data.kind = 'service';
    if (mode === 'session-error') session.isError = true;
    if (mode === 'refreshing') session.isFetching = true;
    showCopy();
    fireEvent.click(screen.getByRole('button', { name: 'Commit…' }));
    await screen.findByText('+only-staged');
    fireEvent.change(screen.getByLabelText('Message du commit'), {
      target: { value: 'Cannot override the identity' },
    });
    expect(
      screen.getByRole('button', { name: 'Confirmer le commit' }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Nom de l’auteur')).toHaveAttribute(
      'readonly',
    );
    expect(screen.getByLabelText('E-mail de l’auteur')).toHaveAttribute(
      'readonly',
    );
    expect(posts()).toHaveLength(0);
  },
);
it('cancels push without a write and freezes the confirmed destination', async () => {
  const view = showCopy();
  fireEvent.click(screen.getByRole('button', { name: 'Push…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
  expect(posts()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Push…' }));
  view.rerender(
    <GitCopyActions
      projectId="p"
      copyId="copy"
      snapshot={{ ...snapshot, head: 'new' }}
      address="https://github.com/other/repo.git"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer le push' }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(JSON.parse(posts()[0][1].body as string)).toMatchObject({
    fingerprint: snapshot.fingerprint,
    address: 'https://github.com/example/demo.git',
  });
});
it('prevents duplicate requests and shows busy errors without closing confirmation', async () => {
  let reject!: (error: Error) => void;
  api.mockImplementation((_url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? new Promise((_resolve, fail) => {
          reject = fail;
        })
      : Promise.resolve({
          fingerprint: snapshot.fingerprint,
          diff: '+only-staged',
        }),
  );
  showCopy();
  fireEvent.click(screen.getByRole('button', { name: 'Push…' }));
  const button = screen.getByRole('button', { name: 'Confirmer le push' });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(posts()).toHaveLength(1));
  await act(async () => reject(new Error('GIT_BUSY')));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Attendez la fin des agents actifs',
  );
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});
it('never enables merge for absent, pending, failed, incomplete or unknown checks', () => {
  const view = render(
    <GitMergeAction
      projectId="p"
      resourceId="git"
      number={12}
      checks={{ ...checks, items: [] }}
      address="https://github.com/example/demo.git"
    />,
    { wrapper },
  );
  expect(
    screen.getByRole('button', { name: 'Fusionner la PR…' }),
  ).toBeDisabled();
  for (const state of [
    { ...checks, mergeable: null },
    { ...checks, limited: true },
    { ...checks, draft: true },
    { ...checks, items: [{ id: 'build', name: 'build', status: 'pending' }] },
  ]) {
    view.rerender(
      <GitMergeAction
        projectId="p"
        resourceId="git"
        number={12}
        checks={state}
        address="https://github.com/example/demo.git"
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Fusionner la PR…' }),
    ).toBeDisabled();
  }
});
it('explains missing write credentials without silently retrying the push', async () => {
  api.mockRejectedValue(new Error('GIT_AUTH_REQUIRED'));
  showCopy();
  fireEvent.click(screen.getByRole('button', { name: 'Push…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer le push' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'jeton autorisant l’écriture',
  );
  expect(posts()).toHaveLength(1);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});
it('distinguishes forbidden write access from missing credentials without retrying', async () => {
  api.mockRejectedValue(new Error('GIT_WRITE_ACCESS_DENIED'));
  showCopy();
  fireEvent.click(screen.getByRole('button', { name: 'Push…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer le push' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'GitHub refuse l’écriture',
  );
  expect(posts()).toHaveLength(1);
});
it('merges only after confirmation and sends both reviewed revisions', async () => {
  render(
    <GitMergeAction
      projectId="p"
      resourceId="git"
      number={12}
      checks={checks}
      address="https://github.com/example/demo.git"
    />,
    { wrapper },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Fusionner la PR…' }));
  expect(posts()).toHaveLength(0);
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Fusionner la PR…',
    }),
  );
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0][0]).toBe('/p/git/connections/git/pull-requests/12/merge');
  expect(JSON.parse(posts()[0][1].body as string)).toEqual({
    head: checks.head,
    baseHead: checks.baseHead,
    address: 'https://github.com/example/demo.git',
  });
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Pull request fusionnée.',
  );
});
