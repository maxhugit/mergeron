import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { GitMerges } from './git-merges';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
let client: QueryClient;
const merges = {
  supported: true,
  limited: false,
  inspectedAt: 1000,
  items: [
    {
      number: 12,
      title: 'Correction fusionnée',
      branch: 'fix/feature',
      base: 'main',
      mergedAt: '2026-10-31T12:00:00Z',
      url: 'https://github.com/example/demo/pull/12',
    },
  ],
};
const checks = {
  head: 'b'.repeat(40),
  limited: false,
  inspectedAt: 1000,
  url: `https://github.com/example/demo/commit/${'b'.repeat(40)}/checks`,
  items: [{ id: 'check-1', name: 'Tests après fusion', status: 'in_progress' }],
};
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api
    .mockReset()
    .mockImplementation((url: string) =>
      Promise.resolve(url.endsWith('/merges') ? merges : checks),
    );
});
afterEach(() => client.clear());
function show() {
  return render(
    <QueryClientProvider client={client}>
      <GitMerges projectId="p" resourceId="git" />
    </QueryClientProvider>,
  );
}

it('shows a strong waiting indicator and the verified PR dependency before any job exists', async () => {
  api.mockImplementation((url: string) =>
    Promise.resolve(
      url.endsWith('/merges')
        ? merges
        : {
            ...checks,
            items: [],
            workflows: {
              available: true,
              limited: false,
              items: [
                {
                  id: 293,
                  name: 'Publication Mergeron',
                  status: 'pending',
                  url: 'https://github.com/example/demo/actions/runs/293',
                  waitReason: 'concurrency',
                  groups: ['mergeron-refs/heads/main'],
                  blockers: [
                    {
                      id: 292,
                      name: 'Publication précédente',
                      status: 'in_progress',
                      pullRequest: 292,
                      url: 'https://github.com/example/demo/actions/runs/292',
                    },
                  ],
                },
              ],
            },
          },
    ),
  );
  const view = show();
  expect(await screen.findByText('Attend la fin de :')).toBeInTheDocument();
  expect(
    screen.getByRole('link', { name: /PR #292/ }),
  ).toHaveAttribute('href', 'https://github.com/example/demo/actions/runs/292');
  const indicator = view.container.querySelector(
    '[data-merge-state="waiting"]',
  )!;
  expect(indicator).toHaveTextContent('En attente');
  expect(indicator.querySelector('svg')).toHaveClass('h-7', 'w-7');
  expect(indicator.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.queryByText(/Aucun check signalé/)).not.toBeInTheDocument();
  expect(screen.queryByText('Checks réussis')).not.toBeInTheDocument();
});

it('keeps an unknown dependency honest and never calls it a verified PR blocker', async () => {
  api.mockImplementation((url: string) =>
    Promise.resolve(
      url.endsWith('/merges')
        ? merges
        : {
            ...checks,
            items: [],
            workflows: {
              available: true,
              limited: false,
              items: [
                {
                  id: 293,
                  name: 'Publication',
                  status: 'queued',
                  url: 'https://github.com/example/demo/actions/runs/293',
                  waitReason: 'unknown',
                  queueLimited: true,
                },
              ],
            },
          },
    ),
  );
  show();
  expect(
    await screen.findByText(/GitHub n’a pas confirmé/),
  ).toBeInTheDocument();
  expect(screen.queryByText('Attend la fin de :')).not.toBeInTheDocument();
});

it('does not keep a green result when Actions observation is unavailable', async () => {
  api.mockImplementation((url: string) =>
    Promise.resolve(
      url.endsWith('/merges')
        ? merges
        : {
            ...checks,
            items: [{ ...checks.items[0], status: 'success' }],
            workflows: { available: false, limited: false, items: [] },
          },
    ),
  );
  const view = show();
  expect(
    await screen.findByText(/État des exécutions indisponible/),
  ).toBeInTheDocument();
  expect(
    view.container.querySelector('[data-merge-state="unknown"]'),
  ).not.toBeNull();
  expect(screen.queryByText('Checks réussis')).not.toBeInTheDocument();
});

it.each([
  ['pending', 'waiting', 'En attente'],
  ['in_progress', 'running', 'En cours'],
  ['failure', 'failed', 'Checks en échec'],
  ['cancelled', 'cancelled', 'Annulé'],
  ['success', 'passed', 'Checks réussis'],
] as const)(
  'updates the strong indicator from Actions state %s',
  async (status, state, label) => {
    api.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/merges')
          ? merges
          : {
              ...checks,
              items: [],
              workflows: {
                available: true,
                limited: false,
                items: [
                  {
                    id: 1,
                    name: 'Publish',
                    status,
                    url: 'https://github.com/example/demo/actions/runs/1',
                  },
                ],
              },
            },
      ),
    );
    const view = show();
    await screen.findByText('Publish');
    expect(
      view.container.querySelector(`[data-merge-state="${state}"]`),
    ).toHaveTextContent(label);
    if (state === 'cancelled') {
      const icon = view.container.querySelector(
        '[data-merge-state="cancelled"] svg',
      );
      expect(icon).toHaveClass('lucide-ban', 'h-7', 'w-7');
      expect(icon).not.toHaveClass('animate-spin');
      expect(screen.queryByText('Checks en échec')).not.toBeInTheDocument();
    }
  },
);

it('shows merge jobs and updates their result when the repository is refreshed', async () => {
  show();
  expect(
    await screen.findByText('#12 Correction fusionnée'),
  ).toBeInTheDocument();
  expect(await screen.findByText('Tests après fusion')).toBeInTheDocument();
  expect(screen.getByText('Commit de fusion : bbbbbbb')).toBeInTheDocument();
  expect(
    screen.getByRole('link', { name: 'Voir les checks sur GitHub' }),
  ).toHaveAttribute('href', checks.url);
  api.mockImplementation((url: string) =>
    Promise.resolve(
      url.endsWith('/merges')
        ? merges
        : { ...checks, items: [{ ...checks.items[0], status: 'success' }] },
    ),
  );
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ['workspace-git-merges', 'p', 'git'],
    });
  });
  expect(await screen.findByText('Checks réussis')).toBeInTheDocument();
});

it('replaces a cached success with an explicit error when verification fails and allows retry', async () => {
  api.mockImplementation((url: string) =>
    Promise.resolve(
      url.endsWith('/merges')
        ? merges
        : { ...checks, items: [{ ...checks.items[0], status: 'success' }] },
    ),
  );
  show();
  expect(await screen.findByText('Checks réussis')).toBeInTheDocument();
  api.mockImplementation((url: string) =>
    url.endsWith('/merges')
      ? Promise.resolve(merges)
      : Promise.reject(new Error('unavailable')),
  );
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ['workspace-git-merges', 'p', 'git', 12],
    });
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Leur réussite n’est pas confirmée',
  );
  expect(screen.queryByText('Checks réussis')).not.toBeInTheDocument();
  api.mockImplementation((url: string) =>
    Promise.resolve(url.endsWith('/merges') ? merges : checks),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
  await waitFor(() =>
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
  );
});

it.each([
  [{ ...merges, items: [] }, 'Aucune fusion'],
  [{ ...merges, supported: false, items: [] }, 'Les PR et checks'],
])('handles empty and unsupported repositories', async (result, expected) => {
  api.mockResolvedValue(result);
  show();
  expect(
    await screen.findByText(new RegExp(expected, 'i')),
  ).toBeInTheDocument();
});
