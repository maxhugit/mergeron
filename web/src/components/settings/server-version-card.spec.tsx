import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { catalogFixture, json } from './catalog/catalog.testing';
import { ServerVersionCard } from './server-version-card';
import { managerStatusQueryKey } from './manager-status-api';

let fixture: ReturnType<typeof catalogFixture>;
let fetchMock: ReturnType<typeof vi.fn>;

const status = {
  installed: {
    version: '0.1.0',
    revision: 'abcdef123456',
    builtAt: '2026-10-20T09:00:00Z',
    channel: 'stable' as const,
  },
  latestVersion: '0.2.1',
  latestPublishedAt: '2026-10-21T10:00:00Z',
  latestUrl: 'https://github.com/maxhugit/mergeron/releases/tag/v0.2.1',
  updateAvailable: true,
  versionStatus: 'update_available' as const,
  releases: [
    {
      version: '0.2.0',
      publishedAt: '2026-10-20T10:00:00Z',
      url: 'https://github.com/maxhugit/mergeron/releases/tag/v0.2.0',
      sections: [{ heading: 'Nouveautés', items: ['Ajoute la recherche.'] }],
    },
    {
      version: '0.2.1',
      publishedAt: '2026-10-21T10:00:00Z',
      url: 'https://github.com/maxhugit/mergeron/releases/tag/v0.2.1',
      sections: [{ heading: 'Corrections', items: ['Corrige le mobile.'] }],
    },
  ],
  checkedAt: '2026-10-21T10:05:00Z',
  checkError: null,
};

beforeEach(async () => {
  await i18n.changeLanguage('en');
  fixture = catalogFixture();
  fixture.queryClient.setQueryData(managerStatusQueryKey, {
    available: false,
    components: [],
  });
  fetchMock = vi.fn(() => Promise.resolve(json(status)));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fixture.dispose();
  vi.unstubAllGlobals();
});

it('shows the installed channel, latest stable version and cumulative changes', async () => {
  fixture.render(<ServerVersionCard />);

  expect(await screen.findByText('0.1.0')).toBeVisible();
  expect(screen.getByText('Stable (latest)')).toBeVisible();
  expect(screen.getByText('0.2.1')).toBeVisible();
  expect(screen.getByText('A new Mergeron image is available.')).toBeVisible();
  expect(screen.getByText('Mergeron 0.2.0')).toBeVisible();
  expect(screen.getByText('Mergeron 0.2.1')).toBeVisible();
  expect(screen.getByText('Ajoute la recherche.')).toBeVisible();
  expect(await screen.findByText('Corrige le mobile.')).toBeVisible();
});

it('keeps the update dialog mounted when the application cannot reach its Manager during restart', async () => {
  fixture.queryClient.setQueryData(managerStatusQueryKey, {
    available: true,
    components: [],
    update: {
      busy: true,
      operation: {
        id: 'active',
        status: 'running',
        phase: 'backingUp',
        backupRetained: false,
        images: {},
        previousImages: {},
        events: [
          { at: '2026-10-25T09:00:00Z', phase: 'backingUp', status: 'running' },
        ],
      },
    },
  });
  fetchMock.mockImplementation((input: RequestInfo | URL) =>
    Promise.resolve(
      json(String(input).includes('/release/') ? status : { available: false }),
    ),
  );
  fixture.render(<ServerVersionCard />);
  const dialog = await screen.findByRole('dialog', { name: 'Update progress' });
  await act(async () => {
    fixture.queryClient.setQueryData(managerStatusQueryKey, {
      available: false,
      components: [],
    });
  });
  expect(dialog).toBeVisible();
  expect(
    await screen.findByText(/The server is temporarily unavailable/),
  ).toBeVisible();
  expect(screen.getByRole('log')).toHaveTextContent('Saving application data');
});

it('refreshes only after the administrator requests it', async () => {
  const user = userEvent.setup();
  fixture.render(<ServerVersionCard />);
  await screen.findByText('0.1.0');

  await user.click(screen.getByRole('button', { name: 'Refresh detection' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls[1]?.[0]).toBe(
    '/api/settings/release/status?refresh=true',
  );
});

it('does not claim that Mergeron is current when discovery fails', async () => {
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      json({
        ...status,
        latestVersion: null,
        latestUrl: null,
        updateAvailable: false,
        versionStatus: 'unknown',
        releases: [],
        checkError: 'unableToCheckForMergeronUpdates',
      }),
    ),
  );
  fixture.render(<ServerVersionCard />);

  expect(
    await screen.findByText('Unable to check for Mergeron updates.'),
  ).toBeVisible();
  expect(
    screen.queryByText('This Mergeron installation is up to date.'),
  ).not.toBeInTheDocument();
});

it('shows one update action alongside the detected image and descriptions', async () => {
  fixture.queryClient.setQueryData(managerStatusQueryKey, {
    available: true,
    mode: 'observe',
    environment: 'development',
    dockerConnected: true,
    components: [],
    dataSafety: { status: 'protected', blockers: [], protectedMounts: [] },
    update: { busy: false, operation: null },
  });
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      json({
        ...status,
        targetImage: 'ghcr.io/maxhugit/mergeron:edge',
        latestRevision: 'b'.repeat(40),
      }),
    ),
  );
  fixture.render(<ServerVersionCard />);
  expect(await screen.findByRole('button', { name: 'Update' })).toBeVisible();
  expect(screen.getAllByRole('button', { name: 'Update' })).toHaveLength(1);
  const update = screen.getByRole('button', { name: 'Update' });
  const refresh = screen.getByRole('button', { name: 'Refresh detection' });
  expect(refresh.parentElement).toBe(update.parentElement);
  expect(update.nextElementSibling).toBe(refresh);
  expect(await screen.findByText('Corrige le mobile.')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Save' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Preview update plan' }),
  ).not.toBeInTheDocument();
});
