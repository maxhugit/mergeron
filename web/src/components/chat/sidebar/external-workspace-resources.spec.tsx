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
import i18n from '@/i18n';
import { locationInventoryFixture } from '@/test/project-locations-fixture';
import { ExternalWorkspaceResources } from './external-workspace-resources';
import type {
  ProjectSummary,
  ProjectWorkspaceResourceSummary,
} from '@/lib/projects-api';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({
  projectsApi: api,
  projectsQueryKey: ['projects'],
}));
vi.mock('./workspace-transfers', () => ({ WorkspaceTransfers: () => null }));
const project: ProjectSummary = {
  id: 'p',
  name: 'Test',
  workspacePath: '/workspaces/p',
  createdAt: 1,
  updatedAt: 1,
  workspaces: [],
  resources: [],
};
const resource: ProjectWorkspaceResourceSummary = {
  id: 'git',
  projectId: 'p',
  localWorkspaceId: null,
  name: 'Git Test',
  type: 'git',
  address: 'https://github.com/example/test.git',
  rootPath: '/',
  accessMode: 'read_write',
  capabilities: { read: true, write: true, execute: false },
  enabled: true,
  connectionState: 'connected',
  lastCheckedAt: 1,
  lastError: null,
  hasSecret: false,
  localPath: null,
};
let client: QueryClient;
let removed = false;
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  removed = false;
  api.mockReset();
  api.mockImplementation(async (_path, init) => {
    if (init?.method === 'DELETE') {
      removed = true;
      return { ok: true, remoteDataDeleted: false };
    }
    return locationInventoryFixture({
      resources: removed ? [] : [resource],
      copies: [],
    });
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  cleanup();
  client.clear();
  await i18n.changeLanguage('en');
});
async function mount() {
  render(
    <QueryClientProvider client={client}>
      <ExternalWorkspaceResources
        project={project}
        pending={false}
        allowCreate={false}
      />
    </QueryClientProvider>,
  );
  await screen.findByText('Git Test');
  fireEvent.click(screen.getByRole('button', { name: 'Détacher du projet' }));
  return screen.getByRole('alertdialog', {
    name: 'Détacher « Git Test » de ce projet ?',
  });
}
async function openEditor() {
  render(
    <QueryClientProvider client={client}>
      <ExternalWorkspaceResources
        project={project}
        pending={false}
        allowCreate={false}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Modifier' }));
  return screen.getByRole('dialog', {
    name: 'Modifier la connexion « Git Test »',
  });
}
it('edits the existing connection with a write-only token, preserving address and permissions', async () => {
  const dialog = await openEditor();
  const token = within(dialog).getByLabelText('Nouveau jeton d’accès', {
    exact: true,
  });
  expect(token).toHaveAttribute('type', 'password');
  expect(token).toHaveValue('');
  expect(within(dialog).getByLabelText('Adresse de connexion')).toHaveAttribute(
    'readonly',
  );
  fireEvent.change(token, { target: { value: 'fake-token-for-test' } });
  expect(api.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(
    false,
  );
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Enregistrer la connexion' }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/p/connections/git',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          name: 'Git Test',
          expectedAddress: resource.address,
          secret: { token: 'fake-token-for-test' },
        }),
      }),
    ),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.queryByDisplayValue('fake-token-for-test')).toBeNull();
  expect(
    api.mock.calls.some(
      ([, init]) => init?.method === 'DELETE' || init?.method === 'POST',
    ),
  ).toBe(false);
});
it('preserves stored credentials when saving with an empty token field', async () => {
  const dialog = await openEditor();
  fireEvent.change(within(dialog).getByLabelText('Nom de la connexion'), {
    target: { value: 'Renamed' },
  });
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Enregistrer la connexion' }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/p/connections/git',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          name: 'Renamed',
          expectedAddress: resource.address,
        }),
      }),
    ),
  );
});
it('clears a token on cancellation and does not submit it', async () => {
  const dialog = await openEditor();
  fireEvent.change(
    within(dialog).getByLabelText('Nouveau jeton d’accès', { exact: true }),
    { target: { value: 'fake-token-for-test' } },
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Annuler' }));
  fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
  expect(
    screen.getByLabelText('Nouveau jeton d’accès', { exact: true }),
  ).toHaveValue('');
  expect(api.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(
    false,
  );
});
it('shows a safe error and clears the token when saving fails', async () => {
  const dialog = await openEditor();
  const original = api.getMockImplementation()!;
  api.mockImplementation((url, init) =>
    init?.method === 'PATCH'
      ? Promise.reject(new Error('do-not-display-secret'))
      : original(url, init),
  );
  fireEvent.change(
    within(dialog).getByLabelText('Nouveau jeton d’accès', { exact: true }),
    { target: { value: 'fake-token-for-test' } },
  );
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Enregistrer la connexion' }),
  );
  await screen.findByRole('alert');
  expect(
    screen.getByLabelText('Nouveau jeton d’accès', { exact: true }),
  ).toHaveValue('');
  expect(screen.queryByText('do-not-display-secret')).toBeNull();
});
it('explains that repository and files are preserved and Cancel does not detach anything', async () => {
  const dialog = await mount();
  expect(dialog).toHaveTextContent(
    'Le dépôt distant et tous les fichiers distants et locaux ne seront PAS supprimés',
  );
  expect(dialog).toHaveTextContent(
    'copies de travail associées seront marquées comme révoquées',
  );
  expect(api.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(
    false,
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Annuler' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Détacher du projet' }),
    ).toHaveFocus(),
  );
  expect(screen.getByText('Git Test')).toBeVisible();
  expect(api.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(
    false,
  );
});
it('detaches only the selected connection after explicit confirmation', async () => {
  const dialog = await mount();
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Détacher du projet' }),
  );
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(
    api.mock.calls.filter(([, init]) => init?.method === 'DELETE'),
  ).toEqual([['/p/connections/git', { method: 'DELETE' }]]);
  expect(screen.queryByText('Git Test')).toBeNull();
});
it('keeps confirmation open on failure and never retries the detachment automatically', async () => {
  const dialog = await mount();
  api.mockImplementation(async (_path, init) => {
    if (init?.method === 'DELETE') throw new Error('Connexion indisponible');
    return locationInventoryFixture({ resources: [resource], copies: [] });
  });
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Détacher du projet' }),
  );
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Connexion indisponible',
  );
  expect(dialog).toBeVisible();
  expect(
    api.mock.calls.filter(([, init]) => init?.method === 'DELETE'),
  ).toHaveLength(1);
  expect(
    within(dialog).getByRole('button', { name: 'Détacher du projet' }),
  ).toBeEnabled();
});
it('blocks duplicate confirmation while detachment is in progress', async () => {
  const dialog = await mount();
  let finish!: (value: unknown) => void;
  api.mockImplementation((_path, init) =>
    init?.method === 'DELETE'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(
          locationInventoryFixture({ resources: [], copies: [] }),
        ),
  );
  const button = within(dialog).getByRole('button', {
    name: 'Détacher du projet',
  });
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(
    within(dialog).getByRole('button', { name: 'Annuler' }),
  ).toBeDisabled();
  fireEvent.click(button);
  expect(
    api.mock.calls.filter(([, init]) => init?.method === 'DELETE'),
  ).toHaveLength(1);
  finish({ ok: true });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
});
