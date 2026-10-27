import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SystemWorkspaceTree } from './system-workspace-tree';

const readTree = vi.hoisted(() => vi.fn());
vi.mock('@/generated/api/@tanstack/react-query.gen', () => ({
  filesReadTreeOptions: ({ query }: { query: { root: string } }) => ({
    queryKey: ['system-tree', query.root],
    queryFn: () => readTree(query.root),
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('system workspace inspection', () => {
  it('browses inside its root, opens files and exposes no mutations', async () => {
    const root = '/workspaces/.mergeron-system/project';
    readTree.mockImplementation(async (path: string) =>
      path === root
        ? [{ name: 'history', path: root + '/history', type: 'directory' }]
        : [
            {
              name: 'version.txt',
              path: root + '/history/version.txt',
              type: 'file',
            },
          ],
    );
    const onFile = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SystemWorkspaceTree root={root} onFile={onFile} />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole('button', { name: 'gitParentFolder' }),
    ).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'history' }));
    fireEvent.click(await screen.findByRole('button', { name: 'version.txt' }));
    expect(onFile).toHaveBeenCalledWith(root + '/history/version.txt');
    expect(screen.getAllByRole('button')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'gitParentFolder' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'gitParentFolder' }),
      ).toBeNull(),
    );
    expect(readTree.mock.calls.every(([path]) => path.startsWith(root))).toBe(
      true,
    );
  });
});
