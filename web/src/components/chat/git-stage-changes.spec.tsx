import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { GitStageChanges } from './git-stage-changes';
import type { GitSnapshot } from '@/lib/workspace-git-api';
import i18n from '@/i18n';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
let client: QueryClient;
const snapshot: GitSnapshot = {
  fingerprint: 'frozen-index',
  branch: 'main',
  head: 'a'.repeat(40),
  ahead: 0,
  behind: 0,
  upstream: null,
  inspectedAt: 1,
  branchesLimited: false,
  branches: [],
  changes: [
    { path: 'coucou.js', status: ' M' },
    { path: 'other.js', status: ' M' },
    { path: 'ready.js', status: 'M ' },
  ],
};
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  api.mockReset().mockImplementation(async (url: string) =>
    url.endsWith('stage-review')
      ? {
          reviewFingerprint: 'reviewed-content',
          files: [
            {
              path: 'coucou.js',
              text: "console.log('coucou');\ntutu\n",
              binary: false,
              deleted: false,
              truncated: false,
            },
          ],
        }
      : {},
  );
});
afterEach(() => client.clear());
function show(
  writable = true,
  view: 'all' | 'prepared' = 'all',
  layout: 'flow' | 'split' = 'flow',
) {
  return render(
    <QueryClientProvider client={client}>
      <GitStageChanges
        projectId="p"
        copyId="copy"
        agentThreadId="agent"
        snapshot={snapshot}
        writable={writable}
        view={view}
        layout={layout}
        onDiff={vi.fn()}
      />
    </QueryClientProvider>,
  );
}
const bodies = () =>
  api.mock.calls.map(([url, options]) => ({
    url,
    body: JSON.parse(options.body as string),
  }));

it('keeps separate labelled lists and a selection action outside the scrolling list', () => {
  show(true, 'all', 'split');
  const unprepared = screen.getByRole('region', {
    name: 'Modifications à préparer (2)',
  });
  const prepared = screen.getByRole('region', {
    name: 'Prêtes pour le commit (1)',
  });
  const pendingList = within(unprepared).getByRole('list');
  const preparedList = within(prepared).getByRole('list');
  expect(pendingList).toHaveAttribute('tabindex', '0');
  expect(preparedList).toHaveAttribute('tabindex', '0');
  expect(
    within(pendingList).getByRole('button', { name: /coucou.js/ }),
  ).toBeVisible();
  expect(
    within(pendingList).queryByRole('button', { name: /ready.js/ }),
  ).toBeNull();
  expect(
    within(preparedList).getByRole('button', { name: /ready.js/ }),
  ).toBeVisible();
  expect(within(preparedList).queryByRole('checkbox')).toBeNull();
  const select = within(unprepared).getByRole('button', {
    name: 'Préparer la sélection',
  });
  expect(pendingList.contains(select)).toBe(false);
});

it('keeps both empty sections present with explicit empty states', () => {
  render(
    <QueryClientProvider client={client}>
      <GitStageChanges
        projectId="p"
        copyId="copy"
        snapshot={{ ...snapshot, changes: [] }}
        writable
        layout="split"
        onDiff={vi.fn()}
      />
    </QueryClientProvider>,
  );
  expect(
    within(
      screen.getByRole('region', { name: 'Modifications à préparer (0)' }),
    ).getByText('Aucune modification à préparer.'),
  ).toBeVisible();
  expect(
    within(
      screen.getByRole('region', { name: 'Prêtes pour le commit (0)' }),
    ).getByText(i18n.t('gitNoPreparedFiles', { ns: 'workspaces' })),
  ).toBeVisible();
  expect(screen.getAllByRole('list')).toHaveLength(2);
  expect(
    screen.queryByRole('button', { name: 'Préparer la sélection' }),
  ).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Retirer du commit' }),
  ).toBeNull();
});

it('compares the correct side of a partly staged file in each split section', () => {
  const onDiff = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <GitStageChanges
        projectId="p"
        copyId="copy"
        snapshot={{
          ...snapshot,
          changes: [{ path: 'mixed.js', status: 'MM' }],
        }}
        writable
        layout="split"
        onDiff={onDiff}
      />
    </QueryClientProvider>,
  );
  const unprepared = screen.getByRole('region', {
    name: 'Modifications à préparer (1)',
  });
  const prepared = screen.getByRole('region', {
    name: 'Prêtes pour le commit (1)',
  });
  fireEvent.click(within(unprepared).getByRole('button', { name: /mixed.js/ }));
  fireEvent.click(within(prepared).getByRole('button', { name: /mixed.js/ }));
  expect(onDiff.mock.calls).toEqual([
    ['mixed.js', false],
    ['mixed.js', true],
  ]);
  expect(within(unprepared).getByRole('checkbox')).toBeVisible();
  expect(within(prepared).queryByRole('checkbox')).toBeNull();
});

it('lists only staged files in commit preparation', async () => {
  show(true, 'prepared');
  expect(screen.getByRole('button', { name: /ready.js/ })).toBeVisible();
  expect(screen.queryByRole('button', { name: /coucou.js/ })).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retirer du commit' }));
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(bodies()[0]).toMatchObject({
    body: {
      paths: ['ready.js'],
      agentThreadId: 'agent',
      fingerprint: 'frozen-index',
    },
  });
});

it('keeps a partly staged file in preparation without offering to stage its newer edits there', () => {
  render(
    <QueryClientProvider client={client}>
      <GitStageChanges
        projectId="p"
        copyId="copy"
        snapshot={{
          ...snapshot,
          changes: [{ path: 'mixed.js', status: 'MM' }],
        }}
        writable
        view="prepared"
        onDiff={vi.fn()}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByRole('button', { name: /mixed.js/ })).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Retirer du commit' }),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Préparer pour le commit' }),
  ).toBeNull();
});

it('reviews then prepares only the selected files with the agent and content fingerprint', async () => {
  show();
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Sélectionner other.js' }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Préparer la sélection' }),
  );
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('tutu');
  expect(bodies()).toEqual([
    {
      url: '/p/git/copies/copy/stage-review',
      body: {
        paths: ['coucou.js'],
        fingerprint: 'frozen-index',
        agentThreadId: 'agent',
      },
    },
  ]);
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Confirmer la préparation' }),
  );
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(bodies()[1]).toEqual({
    url: '/p/git/copies/copy/stage',
    body: {
      paths: ['coucou.js'],
      fingerprint: 'frozen-index',
      reviewFingerprint: 'reviewed-content',
      agentThreadId: 'agent',
    },
  });
  expect(bodies().some((r) => /commit|push/.test(r.url))).toBe(false);
});

it('removes a prepared file from the commit, without requesting a destructive operation', async () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Retirer du commit' }));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  expect(bodies()[0]).toEqual({
    url: '/p/git/copies/copy/unstage',
    body: {
      paths: ['ready.js'],
      fingerprint: 'frozen-index',
      agentThreadId: 'agent',
    },
  });
});

it('has no prepare or unstage controls for a copy reserved to another agent', () => {
  show(false);
  expect(
    screen.queryByRole('button', { name: 'Préparer' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Retirer du commit' }),
  ).not.toBeInTheDocument();
});

it('handles a changed file safely and does not display raw server diagnostics', async () => {
  api.mockRejectedValue(new Error('private-server-diagnostic'));
  show();
  fireEvent.click(
    screen.getByRole('button', { name: 'Préparer la sélection' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('actualisez');
  expect(
    screen.queryByText(/private-server-diagnostic/),
  ).not.toBeInTheDocument();
});
