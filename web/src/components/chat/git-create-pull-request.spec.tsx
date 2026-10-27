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
import { GitCreatePullRequest } from './git-create-pull-request';
import { GitCopyActions } from './workspace-git-actions';
import type { GitSnapshot } from '@/lib/workspace-git-api';
import i18n from '@/i18n';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    data: {
      kind: 'person',
      personId: 'p',
      active: true,
      name: 'Test',
      email: 'test@example.invalid',
    },
    refetch: vi.fn(),
  }),
}));
const snapshot: GitSnapshot = {
  fingerprint: 'state',
  branch: 'feature/test',
  head: 'a'.repeat(40),
  ahead: 0,
  behind: 0,
  upstream: null,
  inspectedAt: 1,
  branchesLimited: false,
  changes: [],
  branches: [],
};
const published = {
  sha: snapshot.head,
  branch: snapshot.branch!,
  address: 'https://github.com/example/demo.git',
};
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  api.mockReset().mockImplementation((url: string, options?: RequestInit) =>
    Promise.resolve(
      options?.method === 'POST'
        ? url.endsWith('/push')
          ? { sha: snapshot.head }
          : {
              number: 12,
              url: 'https://github.com/example/demo/pull/12',
              existing: false,
            }
        : {
            supported: true,
            items: [
              { name: 'main', revision: 'b'.repeat(40) },
              { name: 'feature/test', revision: snapshot.head },
            ],
          },
    ),
  );
});
afterEach(cleanup);
function show(state = snapshot) {
  return render(
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
      <GitCreatePullRequest
        projectId="p"
        copyId="copy"
        resourceId="git"
        agentThreadId="agent"
        snapshot={state}
        published={published}
      />
    </QueryClientProvider>,
  );
}
it('requires an explicit target and confirmation and forwards the draft and user text', async () => {
  show();
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Créer une pull request' }),
  );
  const dialog = screen.getByRole('dialog');
  expect(
    within(dialog).getByRole('button', { name: 'Créer une pull request' }),
  ).toBeDisabled();
  await screen.findByRole('option', { name: 'main' });
  expect(screen.queryByRole('option', { name: 'feature/test' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Branche cible'), {
    target: { value: 'main' },
  });
  fireEvent.change(screen.getByLabelText('Titre de la pull request'), {
    target: { value: 'Reviewed title' },
  });
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: 'Reviewed description' },
  });
  fireEvent.click(screen.getByLabelText('Créer en brouillon'));
  const button = within(dialog).getByRole('button', {
    name: 'Créer une pull request',
  });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/p/git/copies/copy/pull-requests', {
      method: 'POST',
      body: JSON.stringify({
        confirmation: 'CREATE_PULL_REQUEST',
        fingerprint: 'state',
        head: snapshot.head,
        address: published.address,
        agentThreadId: 'agent',
        base: 'main',
        title: 'Reviewed title',
        description: 'Reviewed description',
        draft: true,
      }),
    }),
  );
  expect(
    api.mock.calls.filter(([, options]) => options?.method === 'POST'),
  ).toHaveLength(1);
  expect(
    await screen.findByRole('link', { name: /#12 créée/ }),
  ).toHaveAttribute('href', 'https://github.com/example/demo/pull/12');
});
it('disables a stale published head and creates nothing when cancelled', async () => {
  show({ ...snapshot, head: 'b'.repeat(40) });
  expect(
    screen.getByRole('button', { name: 'Créer une pull request' }),
  ).toBeDisabled();
  cleanup();
  show();
  fireEvent.click(
    screen.getByRole('button', { name: 'Créer une pull request' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
  expect(api.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
    false,
  );
});
it('keeps an uncertain or refused creation visible and never retries the POST automatically', async () => {
  api.mockImplementation((_url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? Promise.reject(new Error('GIT_PR_CREATE_FAILED'))
      : Promise.resolve({
          supported: true,
          items: [{ name: 'main', revision: 'b'.repeat(40) }],
        }),
  );
  show();
  fireEvent.click(
    screen.getByRole('button', { name: 'Créer une pull request' }),
  );
  await screen.findByRole('option', { name: 'main' });
  fireEvent.change(screen.getByLabelText('Branche cible'), {
    target: { value: 'main' },
  });
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Créer une pull request',
    }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'GitHub a refusé la création',
  );
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(
    api.mock.calls.filter(([, options]) => options?.method === 'POST'),
  ).toHaveLength(1);
});
it('offers PR creation only after an explicitly confirmed successful push', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <GitCopyActions
        projectId="p"
        copyId="copy"
        resourceId="git"
        agentThreadId="agent"
        snapshot={snapshot}
        address={published.address}
        actionScope="push"
      />
    </QueryClientProvider>,
  );
  expect(
    screen.queryByRole('button', { name: 'Créer une pull request' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Publier les commits/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer le push' }));
  expect(
    await screen.findByRole('button', { name: 'Créer une pull request' }),
  ).toBeEnabled();
  expect(
    api.mock.calls.some(([url]) => String(url).endsWith('/pull-requests')),
  ).toBe(false);
});
