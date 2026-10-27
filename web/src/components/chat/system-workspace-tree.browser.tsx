import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { page } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SystemWorkspaceTree } from './system-workspace-tree';
import { i18nReady } from '@/i18n';
import '@/index.css';

const root = '/workspaces/.mergeron-system/project';
vi.mock('@/generated/api/@tanstack/react-query.gen', () => ({
  filesReadTreeOptions: ({ query }: { query: { root: string } }) => ({
    queryKey: ['system-tree', query.root],
    queryFn: async () =>
      query.root.endsWith('/history')
        ? [
            {
              name: 'version.pptx',
              path: query.root + '/version.pptx',
              type: 'file',
            },
          ]
        : ['history', 'knowledge'].map((name) => ({
            name,
            path: query.root + '/' + name,
            type: 'directory',
          })),
  }),
}));
afterEach(cleanup);

test('renders the administrative read-only explorer and bounded folder navigation', async () => {
  await i18nReady;
  await page.viewport(1100, 760);
  const onFile = vi.fn();
  render(
    <div
      style={{ width: 430, height: 650 }}
      className="dark flex flex-col bg-background text-foreground"
    >
      <SystemFixture onFile={onFile} />
    </div>,
  );
  await page.getByRole('button', { name: 'history', exact: true }).click();
  await expect
    .element(page.getByRole('button', { name: 'version.pptx', exact: true }))
    .toBeVisible();
  await page.getByRole('button', { name: 'version.pptx', exact: true }).click();
  expect(onFile).toHaveBeenCalledWith(root + '/history/version.pptx');
  await page.screenshot();
  expect(document.querySelectorAll('input, textarea')).toHaveLength(0);
});

export function SystemFixture({ onFile }: { onFile: (path: string) => void }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <SystemWorkspaceTree root={root} onFile={onFile} />
    </QueryClientProvider>
  );
}
