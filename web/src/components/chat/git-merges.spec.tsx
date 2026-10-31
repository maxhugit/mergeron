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
