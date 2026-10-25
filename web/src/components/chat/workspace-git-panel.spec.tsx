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
import { useFilesStore } from '@/stores/files-store';
import type { GitInventory, GitSnapshot } from '@/lib/workspace-git-api';

const api = vi.hoisted(() => vi.fn());
const addRoot = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({
  projectsApi: api,
  projectsQueryKey: ['projects'],
}));
vi.mock('@/generated/api', () => ({ filesAddRoot: addRoot }));
vi.mock('@/components/files/file-tree', () => ({
  FileTree: () => (
    <div data-testid="git-files">{useFilesStore((state) => state.rootDir)}</div>
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
const onSelect = vi.fn();
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  inventory = { resources: [resource], copies: [] };
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  useFilesStore.setState({ rootDir: '/original' });
  onActive.mockReset();
  onFile.mockReset();
  onSelect.mockReset();
  addRoot.mockReset().mockResolvedValue({});
  api.mockReset();
  api.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      inventory = { ...inventory, copies: [copy] };
      return { copy };
    }
    if (url.endsWith('/workspace-resources')) return inventory;
    if (url.includes('/diff?'))
      return { path: 'file.ts', diff: '+changed', untracked: false };
    if (url.endsWith('/copies/copy')) return snapshot;
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
function show(resourceId: string | null = 'git') {
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceGitPanel
        projectId="p"
        resourceId={resourceId}
        onSelect={onSelect}
        cwd="/original"
        activeWorkspacePending={false}
        onActiveWorkspaceChange={onActive}
        onFile={onFile}
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

it('lists remote Git resources before cloning, without changing the agent context', async () => {
  show(null);
  fireEvent.click(await screen.findByRole('button', { name: /Git Test/ }));
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
    '/p/workspace-resources/git/copies',
    expect.objectContaining({
      method: 'POST',
      body: '{"branch":"feature/test"}',
    }),
  );
  expect(onActive).not.toHaveBeenCalled();
  expect(useFilesStore.getState().rootDir).toBe('/original');
});
it('separates browsing files from using the copy as the agent workspace', async () => {
  inventory.copies = [copy];
  show();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Parcourir les fichiers' }),
  );
  expect(await screen.findByTestId('git-files')).toHaveTextContent('/copy');
  expect(onActive).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Utiliser pour cet agent' }),
  );
  expect(onActive).toHaveBeenCalledWith('/copy');
});
it('opens a change comparison and an explicit file, without exposing mutating actions', async () => {
  inventory.copies = [copy];
  show();
  await screen.findByRole('button', { name: 'Parcourir les fichiers' });
  await waitFor(() =>
    expect(
      screen.getByRole('tab', { name: /Modifications/ }),
    ).toHaveTextContent('(1)'),
  );
  tab('Modifications (1)');
  fireEvent.click(screen.getByRole('button', { name: /file.ts/ }));
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('+changed')).toBeInTheDocument();
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Ouvrir le fichier' }),
  );
  expect(onFile).toHaveBeenCalledWith('/copy/file.ts');
  expect(api.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
    false,
  );
});
it('never interprets absent checks or unknown mergeability as approval', async () => {
  show();
  await screen.findByRole('button', { name: 'Préparer une copie de travail' });
  tab('PR / checks');
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
    if (url.endsWith('/workspace-resources')) return inventory;
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
it('ignores a file registration completed after leaving the repository', async () => {
  inventory.copies = [copy];
  let finish!: () => void;
  addRoot.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const view = show();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Parcourir les fichiers' }),
  );
  view.unmount();
  await act(async () => finish());
  expect(useFilesStore.getState().rootDir).toBe('/original');
});
