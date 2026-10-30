import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { GitIntegrateBranch } from './git-integrate-branch';
import type { GitSnapshot } from '@/lib/workspace-git-api';
import i18n from '@/i18n';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
const snapshot: GitSnapshot = {
  fingerprint: 'reviewed',
  head: 'a'.repeat(40),
  branch: 'main',
  changes: [],
  branches: [],
  ahead: 0,
  behind: 0,
  upstream: null,
  inspectedAt: 1,
  branchesLimited: false,
};
const remote = {
  supported: true,
  limited: false,
  inspectedAt: 1,
  items: [
    { name: 'main', revision: 'b'.repeat(40), protected: true },
    { name: 'dev', revision: 'c'.repeat(40), protected: false },
  ],
};
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  api.mockReset();
  api.mockImplementation((_url: string, options?: RequestInit) =>
    Promise.resolve(
      options?.method === 'POST'
        ? { branch: 'main', sha: 'b'.repeat(40) }
        : remote,
    ),
  );
});
function show(state = snapshot, readOnly = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const content = (value: GitSnapshot) => (
    <QueryClientProvider client={client}>
      <GitIntegrateBranch
        projectId="p"
        resourceId="git"
        copyId="copy"
        copyName="Mon dépôt"
        snapshot={value}
        readOnly={readOnly}
        address="https://github.com/example/demo.git"
        agentThreadId="agent"
      />
    </QueryClientProvider>
  );
  const result = render(content(state));
  return {
    client,
    ...result,
    update: (value: GitSnapshot) => result.rerender(content(value)),
  };
}
async function open() {
  fireEvent.click(
    screen.getByRole('button', { name: '↓ Intégrer les commits…' }),
  );
  await screen.findByRole('combobox');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'main' } });
}
it('pins source, destination and fingerprint, sends only after confirmation and reports success', async () => {
  show();
  expect(api).not.toHaveBeenCalled();
  await open();
  expect(screen.getByRole('dialog')).toHaveTextContent(
    'Mon dépôt · branche main',
  );
  expect(
    api.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(0);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dev' } });
  fireEvent.click(
    screen.getByRole('button', { name: 'Récupérer et intégrer' }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/p/git/copies/copy/integrate', {
      method: 'POST',
      body: JSON.stringify({
        fingerprint: 'reviewed',
        address: 'https://github.com/example/demo.git',
        name: 'dev',
        revision: 'c'.repeat(40),
        agentThreadId: 'agent',
        confirmation: 'INTEGRATE_REMOTE_BRANCH',
      }),
    }),
  );
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Copie locale mise à jour',
  );
});
it.each([
  [{ ...snapshot, changes: [{ path: 'edit', status: ' M' }] }, false],
  [snapshot, true],
  [{ ...snapshot, branch: null }, false],
] as Array<[GitSnapshot, boolean]>)(
  'disables integration for dirty, read-only or detached copies',
  (state, readOnly) => {
    show(state, readOnly);
    expect(screen.getByRole('button')).toBeDisabled();
    expect(api).not.toHaveBeenCalled();
  },
);
it('blocks confirmation when the local state changes after review', async () => {
  const view = show();
  await open();
  view.update({ ...snapshot, fingerprint: 'changed' });
  expect(
    screen.getByRole('button', { name: 'Récupérer et intégrer' }),
  ).toBeDisabled();
});
it('keeps conflict errors visible without retrying the write', async () => {
  show();
  await open();
  api.mockRejectedValueOnce(new Error('GIT_LOCAL_MERGE_CONFLICT'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Récupérer et intégrer' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Aucun fichier n’a été modifié',
  );
  expect(
    api.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(1);
  expect(screen.getByRole('dialog')).toBeVisible();
});

it('requires a new review when the selected remote revision changes', async () => {
  const view = show();
  await open();
  view.client.setQueryData(['workspace-git-remote-branches', 'p', 'git'], {
    ...remote,
    items: [{ name: 'main', revision: 'd'.repeat(40), protected: true }],
  });
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Récupérer et intégrer' }),
    ).toBeDisabled(),
  );
  expect(
    api.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(0);
});

it('does not submit twice and keeps the pending operation open', async () => {
  show();
  await open();
  let finish!: (value: { branch: string; sha: string }) => void;
  api.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const confirm = screen.getByRole('button', { name: 'Récupérer et intégrer' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(
      api.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1),
  );
  expect(
    await screen.findByRole('button', { name: 'Intégration en cours…' }),
  ).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Annuler' })).toBeDisabled();
  finish({ branch: 'main', sha: 'b'.repeat(40) });
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Copie locale mise à jour',
  );
});
