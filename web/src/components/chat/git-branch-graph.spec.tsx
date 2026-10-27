import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { GitBranchGraph, graphLayout } from './git-branch-graph';
import type { GitGraph } from '@/lib/workspace-git-api';
import i18n from '@/i18n';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
const node = (
  sha: string,
  parents: string[],
  subject: string,
): GitGraph['items'][number] => ({
  sha,
  parents,
  subject,
  author: 'Test',
  date: '2026-10-27T10:00:00Z',
  current: sha === 'merge',
  refs: sha === 'merge' ? [{ name: 'main', remote: false }] : [],
});
const items = [
  node('merge', ['main-old', 'feature'], 'Merge feature'),
  node('feature', ['root'], 'Feature commit'),
  node('main-old', ['root'], 'Main commit'),
  node('root', [], 'Initial commit'),
];
let client: QueryClient;
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.mockReset().mockResolvedValue({ items, limited: false, inspectedAt: 1 });
});
afterEach(() => client.clear());
it('allocates separate lanes for divergent branches and closes the merge ancestry', () => {
  const graph = graphLayout(items);
  expect(graph.width).toBe(2);
  expect(graph.rows[1].lane).not.toBe(graph.rows[2].lane);
  expect(graph.rows.map((r) => r.item.sha)).toEqual(items.map((i) => i.sha));
});
it('shows branches and selected commit details without any mutation or fetch request', async () => {
  render(
    <QueryClientProvider client={client}>
      <GitBranchGraph projectId="p" copyId="copy" />
    </QueryClientProvider>,
  );
  const feature = await screen.findByRole('button', { name: /Feature commit/ });
  expect(screen.getByText('main')).toBeInTheDocument();
  fireEvent.click(feature);
  expect(
    screen.getByRole('region', { name: 'Détails du commit' }),
  ).toHaveTextContent('feature');
  expect(api).toHaveBeenCalledTimes(1);
  expect(api.mock.calls[0][0]).toBe('/p/git/copies/copy/graph');
  expect(api.mock.calls[0][1].method).toBeUndefined();
});
