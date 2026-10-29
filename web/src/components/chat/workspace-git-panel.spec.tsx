import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { WorkspaceGitPanel } from './workspace-git-panel';
import i18n from '@/i18n';
import { locationInventoryFixture } from '@/test/project-locations-fixture';
import { useFilesStore } from '@/stores/files-store';
import type { GitInventory, GitSnapshot } from '@/lib/workspace-git-api';

const api = vi.hoisted(() => vi.fn());
const addRoot = vi.hoisted(() => vi.fn());
const live = vi.hoisted(() => ({
  listeners: new Map<string, Set<(value: unknown) => void>>(),
  acquire: vi.fn(() => vi.fn()),
}));
vi.mock('@/lib/file-watch-leases', () => ({ acquireFileWatch: live.acquire }));
vi.mock('@/socket', () => ({
  getSocket: () => ({
    on: (name: string, fn: (value: unknown) => void) => {
      const handlers = live.listeners.get(name) ?? new Set();
      handlers.add(fn);
      live.listeners.set(name, handlers);
    },
    off: (name: string, fn: (value: unknown) => void) =>
      live.listeners.get(name)?.delete(fn),
  }),
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    data: {
      kind: 'person',
      personId: 'person',
      name: 'Utilisateur Test',
      email: 'test@example.invalid',
      active: true,
    },
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn().mockResolvedValue({}),
  }),
}));
vi.mock('@/lib/projects-api', () => ({
  projectsApi: api,
  projectsQueryKey: ['projects'],
}));
vi.mock('./workspace-entry-menu', () => ({
  WorkspaceEntryMenu: ({
    items,
  }: {
    items: Array<{ label: string; disabled?: boolean; onSelect: () => void }>;
  }) => (
    <div>
      {items.map((item) => (
        <button
          key={item.label}
          disabled={item.disabled}
          onClick={item.onSelect}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('@/generated/api', () => ({ filesAddRoot: addRoot }));
vi.mock('@/components/files/file-tree', () => ({
  FileTree: ({
    gitFileState,
  }: {
    gitFileState?: (path: string) =>
      | {
          unstaged: boolean;
          actions: Array<{
            label: string;
            disabled?: boolean;
            onSelect: () => void;
          }>;
        }
      | undefined;
  }) => (
    <div data-testid="git-files">
      {useFilesStore((state) => state.rootDir)}
      {gitFileState?.('/copy/file.ts')?.actions.map((action) => (
        <button
          key={action.label}
          disabled={action.disabled}
          onClick={action.onSelect}
        >
          {action.label}
        </button>
      ))}
    </div>
  ),
}));
const resource: GitInventory['resources'][number] = {
  id: 'git',
  projectId: 'p',
  localWorkspaceId: null,
  name: 'Git Test',
  type: 'git',
  address: 'https://github.com/example/demo.git',
  rootPath: '/',
  accessMode: 'read_write',
  capabilities: { read: true, write: true, execute: false },
  enabled: true,
  connectionState: 'connected',
  lastCheckedAt: null,
  lastError: null,
  hasSecret: true,
  localPath: null,
};
const copy: GitInventory['copies'][number] = {
  ownerAgentIds: ['work-agent'],
  id: 'copy',
  projectId: 'p',
  sourceResourceId: 'git',
  localWorkspaceId: 'local',
  name: 'Git — copie',
  branch: 'main',
  revision: 'a'.repeat(40),
  state: 'ready',
  lastError: null,
  localPath: '/copy',
  sourceName: 'Git Test',
  sourceType: 'git',
  accessMode: 'read_write',
  sourceEnabled: true,
  createdAt: 1,
  updatedAt: 1,
};
const snapshot: GitSnapshot = {
  fingerprint: 'f'.repeat(64),
  branch: 'main',
  head: 'a'.repeat(40),
  changes: [{ path: 'file.ts', status: ' M' }],
  branches: [
    {
      name: 'main',
      remote: false,
      revision: 'a'.repeat(40),
      upstream: 'origin/main',
      tracking: '',
    },
  ],
  ahead: 0,
  behind: 0,
  upstream: 'origin/main',
  branchesLimited: false,
  inspectedAt: 1,
};
let inventory: GitInventory;
let client: QueryClient;
const onActive = vi.fn();
const onFile = vi.fn();
const onGitDiff = vi.fn();
const onSelect = vi.fn();
beforeEach(async () => {
  live.listeners.clear();
  live.acquire.mockClear();
  await i18n.changeLanguage('fr');
  inventory = { resources: [resource], copies: [] };
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  useFilesStore.setState({ rootDir: '/original' });
  onActive.mockReset();
  onFile.mockReset();
  onGitDiff.mockReset();
  onSelect.mockReset();
  addRoot.mockReset().mockResolvedValue({});
  api.mockReset();
  api.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      inventory = { ...inventory, copies: [copy] };
      return { copy };
    }
    if (url.endsWith('/locations')) return locationInventoryFixture(inventory);
    if (url.includes('/diff?'))
      return { path: 'file.ts', diff: '+changed', untracked: false };
    if (url.endsWith('/copies/copy')) return snapshot;
    if (url.endsWith('/commits'))
      return {
        items: [
          {
            sha: 'a'.repeat(40),
            date: '2026-10-26T12:00:00Z',
            author: 'Test',
            subject: 'Local change',
          },
        ],
        limited: false,
      };
    if (url.endsWith('/branches'))
      return {
        supported: true,
        items: [
          { name: 'only-on-github', revision: 'b'.repeat(40), protected: true },
        ],
        limited: false,
        inspectedAt: Date.now(),
      };
    if (url.endsWith('/checks'))
      return {
        head: 'a'.repeat(40),
        mergeable: null,
        draft: false,
        limited: false,
        items: [],
      };
    if (url.endsWith('/pull-requests'))
      return {
        supported: true,
        limited: false,
        items: [
          {
            number: 12,
            title: 'Feature',
            draft: false,
            branch: 'feature',
            base: 'main',
            head: 'a'.repeat(40),
            url: 'https://github.com/example/demo/pull/12',
          },
        ],
      };
    throw new Error(`Unexpected request ${url}`);
  });
});
afterEach(() => client.clear());
function show(
  resourceId: string | null = 'git',
  agentThreadId: string = 'work-agent',
  cwd: string = '/original',
) {
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceGitPanel
        agentThreadId={agentThreadId}
        projectId="p"
        resourceId={resourceId}
        onSelect={onSelect}
        cwd={cwd}
        activeWorkspacePending={false}
        onActiveWorkspaceChange={onActive}
        onFile={onFile}
        onGitDiff={onGitDiff}
        onGitGraph={() => undefined}
      >
        <div>Local tree</div>
      </WorkspaceGitPanel>
    </QueryClientProvider>,
  );
}
const tab = (name: string) =>
  fireEvent.mouseDown(screen.getByRole('tab', { name }), {
    button: 0,
    ctrlKey: false,
  });

it.each([
  ['/original', '/original/sources/copy', false],
  ['/original/sources/copy', '/original/sources/copy', true],
  ['/original/sources/copy/src', '/original/sources/copy', true],
  ['/original/sources/copy-other', '/original/sources/copy', false],
])(
  'marks a Git copy active only when cwd %s is inside %s',
  async (cwd, localPath, active) => {
    inventory.copies = [{ ...copy, localPath, ownerAgentIds: ['work-agent'] }];
    show(null, 'work-agent', cwd);
    await screen.findByText('Local : main · aaaaaaa');
    expect(screen.queryByLabelText('Active pour cet agent') !== null).toBe(
      active,
    );
  },
);

it('reserves a copy to its agent and disables creating a second copy for that agent', async () => {
  inventory.copies = [{ ...copy, ownerAgentIds: ['work-agent'] }];
  show('git', 'work-agent');
  expect(await screen.findByText('Local : main · aaaaaaa')).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Préparer une copie de travail' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Utiliser pour cet agent' }),
  ).toBeEnabled();
});

it('does not expose another agent’s copy as this agent’s local copy', async () => {
  inventory.copies = [{ ...copy, ownerAgentIds: ['other-agent'] }];
  show('git', 'work-agent');
  await screen.findByRole('tab', { name: 'Local' });
  expect(await screen.findByText('Aucune copie locale')).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Parcourir les fichiers locaux' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Utiliser pour cet agent' }),
  ).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Commit…' })).toBeNull();
  expect(api.mock.calls.some(([url]) => url.endsWith('/copies/copy'))).toBe(
    false,
  );
});
it('lists remote Git resources before cloning, without changing the agent context', async () => {
  show(null);
  fireEvent.click(await screen.findByRole('button', { name: /^Git Test/ }));
  expect(onSelect).toHaveBeenCalledWith('git');
  expect(onActive).not.toHaveBeenCalled();
  expect(useFilesStore.getState().rootDir).toBe('/original');
  expect(addRoot).not.toHaveBeenCalled();
});
it('creates an explicit isolated copy and never selects it for the agent automatically', async () => {
  show();
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Préparer une copie de travail',
    }),
  );
  fireEvent.change(
    screen.getByLabelText('Branche distante existante (facultatif)'),
    { target: { value: 'feature/test' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Créer la copie' }));
  await screen.findByRole('button', { name: 'Utiliser pour cet agent' });
  expect(api).toHaveBeenCalledWith(
    '/p/connections/git/copies',
    expect.objectContaining({
      method: 'POST',
      body: '{"branch":"feature/test","agentThreadId":"work-agent"}',
    }),
  );
  expect(onActive).not.toHaveBeenCalled();
  expect(await screen.findByTestId('git-files')).toHaveTextContent('/copy');
});
it('separates browsing files from using the copy as the agent workspace', async () => {
  inventory.copies = [copy];
  show();
  expect(await screen.findByTestId('git-files')).toHaveTextContent('/copy');
  expect(
    screen.queryByRole('button', {
      name: 'Parcourir les fichiers',
    }),
  ).toBeNull();
  expect(addRoot).toHaveBeenCalledTimes(1);
  expect(onActive).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Utiliser pour cet agent' }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Utiliser pour cet agent' }),
  );
  expect(onActive).toHaveBeenCalledWith('/copy');
});
it('confirms recoverable removal of the selected copy without changing the agent folder', async () => {
  inventory.copies = [copy];
  const implementation = api.getMockImplementation()!;
  api.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'DELETE') {
      inventory.copies = [];
      return { recoveryPath: '/project/sources/.external/.trash/copy' };
    }
    return implementation(url, options);
  });
  show();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Supprimer cette copie…' }),
  );
  const dialog = screen.getByRole('alertdialog');
  expect(within(dialog).getByText('/copy')).toBeVisible();
  expect(
    api.mock.calls.some(([, options]) => options?.method === 'DELETE'),
  ).toBe(false);
  fireEvent.click(
    within(dialog).getByRole('button', {
      name: 'Confirmer la suppression locale',
    }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/p/workspace-resources/copies/copy',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({
          confirmation: 'REMOVE_WORKING_COPY',
          path: '/copy',
        }),
      }),
    ),
  );
  expect(await screen.findByRole('status')).toHaveTextContent(
    '/project/sources/.external/.trash/copy',
  );
  expect(onActive).not.toHaveBeenCalled();
  expect(
    screen.queryByText(/Copie utilisée par l’agent/),
  ).not.toBeInTheDocument();
});
it('opens a change comparison and an explicit file, without exposing mutating actions', async () => {
  inventory.copies = [copy];
  show();
  await screen.findByTestId('git-files');
  await waitFor(() =>
    expect(
      screen.getByRole('tab', { name: /Modifications/ }),
    ).toHaveTextContent('(1)'),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Voir les différences Git' }),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(onGitDiff).toHaveBeenCalledWith({
    projectId: 'p',
    copyId: 'copy',
    path: 'file.ts',
    localPath: '/copy',
    status: ' M',
  });
  expect(onFile).not.toHaveBeenCalled();
  expect(api.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
    false,
  );
});

it('shows tracked, untracked and staged agent changes with the correct comparison source', async () => {
  inventory.copies = [copy];
  const implementation = api.getMockImplementation()!;
  api.mockImplementation(async (url: string, options?: RequestInit) =>
    url.endsWith('/copies/copy')
      ? {
          ...snapshot,
          changes: [
            { path: 'file.ts', status: ' M' },
            { path: 'new.ts', status: '??' },
            { path: 'ready.ts', status: 'M ' },
            { path: 'mixed.ts', status: 'MM' },
          ],
        }
      : implementation(url, options),
  );
  show();
  await screen.findByRole('tab', { name: 'Modifications (4)' });
  expect(screen.getByText(/4 fichiers modifiés/)).toBeVisible();
  tab('Modifications (4)');
  expect(await screen.findByRole('button', { name: /new.ts/ })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /file.ts/ }));
  expect(onGitDiff).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: 'file.ts', staged: false }),
  );
  fireEvent.click(screen.getByRole('button', { name: /ready.ts/ }));
  expect(onGitDiff).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: 'ready.ts', staged: true }),
  );
  const mixed = screen.getAllByRole('button', { name: /mixed.ts/ });
  expect(mixed).toHaveLength(2);
  fireEvent.click(mixed[0]);
  expect(onGitDiff).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: 'mixed.ts', staged: false }),
  );
  fireEvent.click(mixed[1]);
  expect(onGitDiff).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: 'mixed.ts', staged: true }),
  );
  expect(api.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
    false,
  );
});

it('refreshes the Changes tab after an agent write without manual refresh or staging', async () => {
  inventory.copies = [copy];
  const implementation = api.getMockImplementation()!;
  let changes = snapshot.changes;
  api.mockImplementation(async (url: string, options?: RequestInit) =>
    url.endsWith('/copies/copy')
      ? { ...snapshot, changes }
      : implementation(url, options),
  );
  show();
  await screen.findByRole('tab', { name: 'Modifications (1)' });
  tab('Modifications (1)');
  changes = [...changes, { path: 'agent-created.ts', status: '??' }];
  act(() => {
    for (const fn of live.listeners.get('fs.changed') ?? [])
      fn({ watchPath: '/copy', changedPaths: ['/copy/agent-created.ts'] });
  });
  expect(
    await screen.findByRole('tab', { name: 'Modifications (2)' }),
  ).toBeVisible();
  expect(
    await screen.findByRole('button', { name: /agent-created.ts/ }),
  ).toBeVisible();
  expect(api.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
    false,
  );
});
it('never interprets absent checks or unknown mergeability as approval', async () => {
  show();
  await screen.findByRole('button', { name: 'Préparer une copie de travail' });
  tab('GitHub');
  fireEvent.click(await screen.findByRole('button', { name: '#12 Feature' }));
  expect(
    await screen.findByText('Détection des conflits en cours ou indisponible.'),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      'Aucun check signalé. Cela ne signifie pas que la fusion est autorisée.',
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /fusionner/i })).toBeDisabled();
});
it('shows failed inspection instead of a stale clean state', async () => {
  inventory.copies = [copy];
  api.mockImplementation(async (url: string) => {
    if (url.endsWith('/locations')) return locationInventoryFixture(inventory);
    throw new Error('offline');
  });
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Impossible d’inspecter cette copie',
  );
  tab('Modifications');
  expect(
    screen.queryByText('Aucune modification locale.'),
  ).not.toBeInTheDocument();
});

it.each([
  ['GIT_OUTPUT_LIMIT_EXCEEDED', 'limite de 1 Mio'],
  ['GIT_COMMAND_TIMEOUT', 'délai autorisé'],
])(
  'explains the inspection refusal %s rather than reporting a clean copy',
  async (code, message) => {
    inventory.copies = [copy];
    api.mockImplementation(async (url: string) => {
      if (url.endsWith('/locations'))
        return locationInventoryFixture(inventory);
      throw new Error(code);
    });
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    tab('Modifications');
    expect(
      screen.queryByText('Aucune modification locale.'),
    ).not.toBeInTheDocument();
  },
);
it('ignores a file registration completed after leaving the repository', async () => {
  inventory.copies = [copy];
  let finish!: () => void;
  addRoot.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const view = show();
  await waitFor(() => expect(addRoot).toHaveBeenCalled());
  view.unmount();
  await act(async () => finish());
  expect(useFilesStore.getState().rootDir).toBe('/original');
});

it('retries an automatic tree load after failure without activating the agent folder', async () => {
  inventory.copies = [copy];
  addRoot.mockRejectedValueOnce(new Error('unavailable'));
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent('Impossible');
  expect(useFilesStore.getState().rootDir).toBe('/original');
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
  expect(await screen.findByTestId('git-files')).toHaveTextContent('/copy');
  expect(onActive).not.toHaveBeenCalled();
});

it('does not adopt a late root after switching away from Files, and loads on return', async () => {
  inventory.copies = [copy];
  let finish!: () => void;
  addRoot.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  show();
  await waitFor(() => expect(addRoot).toHaveBeenCalledTimes(1));
  tab('GitHub');
  await act(async () => finish());
  expect(useFilesStore.getState().rootDir).toBe('/original');
  tab('Local');
  expect(await screen.findByTestId('git-files')).toHaveTextContent('/copy');
  act(() => useFilesStore.getState().setRootDir('/copy/subdirectory'));
  tab('Commits');
  tab('Fichiers');
  expect(await screen.findByTestId('git-files')).toHaveTextContent(
    '/copy/subdirectory',
  );
  expect(addRoot).toHaveBeenCalledTimes(2);
  expect(onActive).not.toHaveBeenCalled();
});

it('keeps the branch pane compact without duplicating graph access or help text', async () => {
  inventory.copies = [copy];
  show();
  await screen.findByTestId('git-files');
  tab('Branches');
  expect(
    await screen.findByRole('button', { name: 'Créer une branche' }),
  ).toBeVisible();
  const pane = within(screen.getByRole('tabpanel', { name: 'Branches' }));
  expect(
    pane.queryByRole('button', {
      name: 'Afficher le graphe des branches et commits',
    }),
  ).toBeNull();
  expect(
    screen.getByRole('button', {
      name: 'Afficher le graphe des branches et commits',
    }),
  ).toBeEnabled();
  expect(screen.queryByText(/Branches locales de cette copie/)).toBeNull();
});

it('separates local history from live GitHub branches and never activates a copy by browsing remote data', async () => {
  inventory.copies = [copy];
  show();
  await screen.findByTestId('git-files');
  expect(screen.queryByRole('tab', { name: 'PR / checks' })).toBeNull();
  tab('Commits');
  expect(await screen.findByText('Local change')).toBeVisible();
  tab('GitHub');
  expect(await screen.findByRole('tab', { name: 'PR / checks' })).toBeVisible();
  expect(screen.queryByText(/Données consultées sur GitHub/)).toBeNull();
  expect(screen.getByText('Local change')).not.toBeVisible();
  tab('Branches publiées');
  expect(await screen.findByText('only-on-github')).toBeVisible();
  expect(onActive).not.toHaveBeenCalled();
  expect(useFilesStore.getState().rootDir).toBe('/copy');
  expect(
    screen
      .getAllByRole('button', { name: 'Préparer une copie de travail' })
      .every((button) => (button as HTMLButtonElement).disabled),
  ).toBe(true);
  expect(api.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
    false,
  );
});

it('keeps remote GitHub data usable without a local copy and keeps synchronization explicit', async () => {
  show();
  await screen.findByRole('tab', { name: 'Local' });
  tab('GitHub');
  expect(await screen.findByText(/#12 Feature/)).toBeVisible();
  expect(screen.queryByRole('region', { name: 'Synchronisation' })).toBeNull();
  tab('Synchronisation');
  expect(
    screen.getByRole('button', { name: '↓ Intégrer les commits…' }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Actualiser le dépôt' }));
  expect(onActive).not.toHaveBeenCalled();
  expect(api.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
    false,
  );
});

it('has one shared refresh after the scope tabs and refreshes inactive data for this repository only', async () => {
  inventory.copies = [copy];
  const local = vi.fn().mockResolvedValue({ items: [], limited: false });
  const remote = vi.fn().mockResolvedValue({ items: [], supported: true });
  const checks = vi.fn().mockResolvedValue({ items: [] });
  const other = vi.fn().mockResolvedValue({ items: [] });
  await client.fetchQuery({
    queryKey: ['workspace-git-commits', 'p', 'copy'],
    queryFn: local,
  });
  await client.fetchQuery({
    queryKey: ['workspace-git-remote-branches', 'p', 'git'],
    queryFn: remote,
  });
  await client.fetchQuery({
    queryKey: ['workspace-git-checks', 'p', 'git', 12],
    queryFn: checks,
  });
  await client.fetchQuery({
    queryKey: ['workspace-git-checks', 'other-project', 'git', 12],
    queryFn: other,
  });
  show();
  const refresh = await screen.findByRole('button', {
    name: 'Actualiser le dépôt',
  });
  expect(
    refresh.parentElement?.querySelector('[role="tablist"]'),
  ).not.toBeNull();
  fireEvent.click(refresh);
  await waitFor(() => expect(local).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(remote).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(checks).toHaveBeenCalledTimes(2));
  expect(other).toHaveBeenCalledTimes(1);
  for (const scope of ['GitHub', 'Synchronisation', 'Local']) {
    tab(scope);
    expect(
      screen.getAllByRole('button', { name: 'Actualiser le dépôt' }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole('button', { name: 'Actualiser les données GitHub' }),
    ).toBeNull();
  }
  expect(onActive).not.toHaveBeenCalled();
  expect(api.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
    false,
  );
});

it('refreshes remote files at the latest revision while preserving the browsed directory', async () => {
  const fallback = api.getMockImplementation()!;
  api.mockImplementation((url: string, options?: RequestInit) => {
    if (url.includes('/files?'))
      return Promise.resolve({
        ref: 'head-sha',
        path: '',
        items: [{ name: 'docs', path: 'docs', type: 'dir', size: 0 }],
        limited: false,
        content: null,
      });
    return fallback(url, options);
  });
  show();
  await screen.findByRole('tab', { name: 'Local' });
  tab('GitHub');
  tab('Fichiers');
  fireEvent.click(await screen.findByRole('button', { name: 'docs' }));
  await waitFor(() =>
    expect(
      api.mock.calls.some(([url]) =>
        String(url).includes('path=docs&ref=head-sha'),
      ),
    ).toBe(true),
  );
  const before = api.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Actualiser le dépôt' }));
  await waitFor(() =>
    expect(
      api.mock.calls
        .slice(before)
        .some(([url]) => String(url).endsWith('/files?path=docs')),
    ).toBe(true),
  );
  expect(screen.queryByRole('button', { name: /^Actualiser$/ })).toBeNull();
});

it('places publication only in Synchronization and keeps commits local', async () => {
  inventory.copies = [copy];
  show();
  await screen.findByRole('tab', { name: 'Modifications (1)' });
  tab('Modifications (1)');
  await screen.findByRole('button', { name: 'Commit…' });
  expect(screen.queryByRole('region', { name: 'Synchronisation' })).toBeNull();
  tab('Synchronisation');
  const sync = screen.getByRole('region', { name: 'Synchronisation' });
  expect(
    within(sync).getByRole('button', { name: '↑ Publier les commits…' }),
  ).toBeVisible();
  expect(within(sync).queryByRole('button', { name: 'Commit…' })).toBeNull();
  tab('GitHub');
  expect(screen.queryByRole('button', { name: 'Commit…' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Synchronisation' })).toBeNull();
});

it('does not expose publication for a read-only resource', async () => {
  inventory = {
    resources: [{ ...resource, accessMode: 'read_only' }],
    copies: [copy],
  };
  show();
  await screen.findByTestId('git-files');
  expect(screen.queryByRole('button', { name: 'Commit…' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: '↑ Publier les commits…' }),
  ).toBeNull();
});
