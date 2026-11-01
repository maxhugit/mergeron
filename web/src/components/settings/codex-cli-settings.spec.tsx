import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { catalogFixture, json } from './catalog/catalog.testing';
import { CodexCliSettings } from './codex-cli-settings';

let fixture: ReturnType<typeof catalogFixture>;
let fetchMock: ReturnType<typeof vi.fn>;
const available = {
  installedVersion: '1.0.0',
  selectedVersion: null,
  installationState: 'legacy' as const,
  latestVersion: '1.1.0',
  updateAvailable: true,
  installedError: null,
  checkError: null,
  checkedAt: null,
  canManage: true,
  canRollback: false,
  busy: false,
};
beforeEach(() => {
  fixture = catalogFixture();
  fetchMock = vi.fn((url: string, options?: RequestInit) =>
    Promise.resolve(
      json(
        options?.method === 'POST'
          ? { success: true }
          : url.endsWith('/releases')
            ? {
                fromVersion: '1.0.0',
                toVersion: '1.1.0',
                releaseError: null,
                releases: [
                  {
                    version: '1.1.0',
                    publishedAt: '2026-10-15T21:30:38Z',
                    url: 'https://github.com/openai/codex/releases/tag/rust-v1.1.0',
                    sections: [
                      {
                        heading: 'New Features',
                        items: ['A verified official release highlight.'],
                      },
                    ],
                  },
                ],
              }
            : available,
      ),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
});

it('offers a first install and sends only the verified target version', async () => {
  fetchMock.mockImplementation((_url: string, options?: RequestInit) =>
    Promise.resolve(
      json(
        options?.method === 'POST'
          ? { success: true }
          : {
              ...available,
              installedVersion: null,
              installationState: 'missing',
              updateAvailable: false,
            },
      ),
    ),
  );
  const user = userEvent.setup();
  fixture.render(<CodexCliSettings />);
  expect(await screen.findByText('Not installed')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Install Codex CLI' }));
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/codex/cli/install',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ targetVersion: '1.1.0' }),
      }),
    ),
  );
});

it('blocks official updates and installs only the observed Manager identity after confirmation', async () => {
  const release = {
    id: '0.164.0-mergeron.1',
    upstreamVersion: '0.164.0',
    upstreamCommit: 'a'.repeat(40),
    patchSha256: 'b'.repeat(64),
    manifestSha256: 'c'.repeat(64),
  };
  fetchMock.mockImplementation((url: string, options?: RequestInit) =>
    Promise.resolve(
      json(
        options?.method === 'POST'
          ? { success: true }
          : url.endsWith('/releases')
            ? {
                fromVersion: '1.0.0',
                toVersion: '1.1.0',
                releases: [],
                releaseError: null,
              }
            : {
                ...available,
                officialUpdateBlocked: true,
                managedRelease: release,
              },
      ),
    ),
  );
  const user = userEvent.setup();
  fixture.render(<CodexCliSettings />);
  await screen.findByText('0.164.0-mergeron.1');
  expect(
    screen.getByRole('button', { name: 'Update Codex CLI' }),
  ).toBeDisabled();
  await user.click(
    screen.getByRole('button', { name: 'Install the Manager-validated CLI' }),
  );
  expect(
    fetchMock.mock.calls.some(([, options]) => options?.method === 'POST'),
  ).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/codex/cli/managed',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          releaseId: release.id,
          manifestSha256: release.manifestSha256,
          expectedSelection: null,
        }),
      }),
    ),
  );
});

it('does not offer an official fallback when Manager is unavailable', async () => {
  fetchMock.mockResolvedValue(
    json({
      ...available,
      officialUpdateBlocked: true,
      managerError: 'unavailable',
      managedRelease: null,
    }),
  );
  fixture.render(<CodexCliSettings />);
  await screen.findByText(/The Manager does not provide a validated CLI/);
  expect(
    screen.getByRole('button', { name: 'Update Codex CLI' }),
  ).toBeDisabled();
  expect(
    screen.queryByRole('button', { name: 'Install the Manager-validated CLI' }),
  ).not.toBeInTheDocument();
});

it('loads managed CLI copy from Codex settings in French without growing the shared catalog', async () => {
  const releaseId = '0.164.0-mergeron.1';
  fetchMock.mockResolvedValue(
    json({
      ...available,
      officialUpdateBlocked: true,
      managedRelease: { id: releaseId, manifestSha256: 'a'.repeat(64) },
    }),
  );
  await i18n.changeLanguage('fr');
  try {
    expect(
      i18n.getResource('fr', 'common', 'installManagedCli'),
    ).toBeUndefined();
    const user = userEvent.setup();
    fixture.render(<CodexCliSettings />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Installer le CLI validé du Manager',
      }),
    );
    expect(
      await screen.findByRole('heading', {
        name: 'Installer le CLI validé du Manager',
      }),
    ).toBeVisible();
    expect(
      await screen.findByText(
        new RegExp(`Installer ${releaseId} depuis le paquet du Manager`),
      ),
    ).toBeVisible();
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === 'POST'),
    ).toBe(false);
  } finally {
    await i18n.changeLanguage('en');
  }
});
afterEach(() => {
  fixture.dispose();
  vi.unstubAllGlobals();
});

it('displays installed and latest versions and only updates after explicit confirmation', async () => {
  const user = userEvent.setup();
  fixture.render(<CodexCliSettings />);
  await screen.findByText('A CLI update is available');
  expect(
    await screen.findByText('Changes between 1.0.0 and 1.1.0'),
  ).toBeVisible();
  expect(
    await screen.findByText('A verified official release highlight.'),
  ).toBeVisible();
  expect(
    screen.getByRole('link', { name: 'Open the official release note' }),
  ).toHaveAttribute(
    'href',
    'https://github.com/openai/codex/releases/tag/rust-v1.1.0',
  );
  expect(
    fetchMock.mock.calls.some(([, options]) => options?.method === 'POST'),
  ).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Update Codex CLI' }));
  expect(
    fetchMock.mock.calls.some(([, options]) => options?.method === 'POST'),
  ).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/codex/cli/update',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: '1.0.0',
          targetVersion: '1.1.0',
        }),
      }),
    ),
  );
});

it('does not claim up-to-date status when the registry check failed', async () => {
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      json({
        ...available,
        latestVersion: null,
        updateAvailable: false,
        checkError: 'Unable to check npm for updates',
      }),
    ),
  );
  fixture.render(<CodexCliSettings />);
  await screen.findByText('Unable to check npm for updates');
  expect(
    screen.getByRole('button', { name: 'Update Codex CLI' }),
  ).toBeDisabled();
  expect(
    screen.queryByText('No newer stable CLI version is available'),
  ).not.toBeInTheDocument();
});

it('translates official release copy into French and preserves English source copy', async () => {
  const source =
    'Open /config to search preferences across categories, change supported settings immediately, and see which changes require a restart. (#52990, #53429)';
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(
      json(
        url.endsWith('/releases')
          ? {
              fromVersion: '1.0.0',
              toVersion: '1.1.0',
              releaseError: null,
              releases: [
                {
                  version: '1.1.0',
                  publishedAt: '2026-10-15T21:30:38Z',
                  url: 'https://github.com/openai/codex/releases/tag/rust-v1.1.0',
                  sections: [{ heading: 'New Features', items: [source] }],
                },
              ],
            }
          : available,
      ),
    ),
  );
  await i18n.changeLanguage('fr');
  fixture.render(<CodexCliSettings />);
  expect(
    await screen.findByText(
      'Ouvrez /config pour rechercher des préférences dans toutes les catégories, modifier immédiatement les réglages pris en charge et identifier les changements qui nécessitent un redémarrage. (#52990, #53429)',
    ),
  ).toBeVisible();
  expect(screen.queryByText(source)).not.toBeInTheDocument();

  await i18n.changeLanguage('en');
  expect(await screen.findByText(source)).toBeVisible();
});

it('offers rollback for a selected installation even if its binary cannot run', async () => {
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      json({
        ...available,
        installedVersion: null,
        selectedVersion: '1.1.0',
        installationState: 'managed',
        canRollback: true,
      }),
    ),
  );
  const user = userEvent.setup();
  fixture.render(<CodexCliSettings />);
  await user.click(
    await screen.findByRole('button', { name: 'Restore previous CLI' }),
  );
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/codex/cli/rollback',
      expect.objectContaining({
        body: JSON.stringify({ expectedVersion: '1.1.0' }),
      }),
    ),
  );
});

it('explains an untrusted application in French instead of showing the internal error code', async () => {
  fetchMock.mockResolvedValue(
    json({ ...available, installedError: 'codexRuntimeApplicationNotManaged' }),
  );
  await i18n.changeLanguage('fr');
  try {
    fixture.render(<CodexCliSettings />);
    expect(
      await screen.findByText(
        'Le conteneur de l’application n’est pas reconnu comme géré : vérifiez son adoption dans Infrastructure avant d’installer le CLI validé.',
      ),
    ).toBeVisible();
    expect(screen.queryByText('codexRuntimeApplicationNotManaged')).toBeNull();
  } finally {
    await i18n.changeLanguage('en');
  }
});
