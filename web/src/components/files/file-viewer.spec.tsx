import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FileViewer } from './file-viewer';
import i18n, { i18nReady } from '@/i18n';
const api = vi.hoisted(() => ({
  metadata: vi.fn(async (path: string) => ({
    path,
    type: path.endsWith('.txt') ? 'file' : 'directory',
  })),
  tree: vi.fn(async (root: string) =>
    root.endsWith('/nested')
      ? []
      : [
          { name: 'nested', path: root + '/nested', type: 'directory' },
          { name: 'desktop.txt', path: root + '/desktop.txt', type: 'file' },
        ],
  ),
  content: vi.fn(),
}));
vi.mock('@/generated/api/@tanstack/react-query.gen', () => ({
  filesGetMetadataOptions: ({ query }: { query: { path: string } }) => ({
    queryKey: ['metadata', query.path],
    queryFn: () => api.metadata(query.path),
  }),
  filesReadTreeOptions: ({ query }: { query: { root: string } }) => ({
    queryKey: ['tree', query.root],
    queryFn: () => api.tree(query.root),
  }),
}));
vi.mock('@/stores/document-store', () => ({
  ensureDocumentIdentity: (path: string) => path,
  pinDocument: vi.fn(),
  releaseDocument: vi.fn(),
  useDocumentStore: (
    select: (state: {
      pathIndex: Record<string, string>;
      documents: Record<string, never>;
    }) => unknown,
  ) => select({ pathIndex: {}, documents: {} }),
}));
vi.mock('@/hooks/use-file-watch', () => ({ useFileWatch: vi.fn() }));
vi.mock('./viewers', () => ({
  FileContentViewer: ({ filePath }: { filePath: string }) => {
    api.content(filePath);
    return <div data-testid="file-content">{filePath}</div>;
  },
}));
beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await i18nReady;
  await i18n.changeLanguage('fr');
});
function show(path = '/workspace/report.png') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FileViewer filePath={path} viewId="test" />
    </QueryClientProvider>,
  );
}
it('opens a directory with a file extension as a listing without mounting any file reader', async () => {
  show();
  expect(
    await screen.findByRole('region', { name: 'Contenu du dossier' }),
  ).toBeVisible();
  expect(
    await screen.findByRole('button', { name: 'desktop.txt' }),
  ).toBeVisible();
  expect(api.content).not.toHaveBeenCalled();
  expect(api.tree).toHaveBeenCalledWith('/workspace/report.png');
});
it('navigates subdirectories, handles empty folders and returns to the original listing', async () => {
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'nested' }));
  expect(await screen.findByText('Répertoire vide')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Retour' }));
  expect(
    await screen.findByRole('button', { name: 'desktop.txt' }),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: 'Retour' })).toBeDisabled();
});
it('opens a listed file in the tab and returns to its folder', async () => {
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'desktop.txt' }));
  expect(await screen.findByTestId('file-content')).toHaveTextContent(
    '/workspace/report.png/desktop.txt',
  );
  expect(api.content).toHaveBeenCalledWith('/workspace/report.png/desktop.txt');
  fireEvent.click(screen.getByRole('button', { name: 'Retour' }));
  expect(await screen.findByRole('button', { name: 'nested' })).toBeVisible();
  expect(screen.queryByTestId('file-content')).toBeNull();
});
it('shows a refused metadata request without attempting a file read', async () => {
  api.metadata.mockRejectedValueOnce(new Error('Access denied'));
  show('/restricted');
  expect(await screen.findByRole('alert')).toHaveTextContent('Access denied');
  expect(api.tree).not.toHaveBeenCalled();
  expect(api.content).not.toHaveBeenCalled();
});
it('shows a directory listing failure and supports retry', async () => {
  api.tree.mockRejectedValueOnce(new Error('Directory unavailable'));
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Directory unavailable',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
  expect(
    await screen.findByRole('button', { name: 'desktop.txt' }),
  ).toBeVisible();
});

it('uses the host tab opener for a listed file when provided', async () => {
  const onOpenFile = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <FileViewer
        filePath="/workspace/reports"
        viewId="tab"
        onOpenFile={onOpenFile}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'desktop.txt' }));
  expect(onOpenFile).toHaveBeenCalledWith('/workspace/reports/desktop.txt');
  expect(api.content).not.toHaveBeenCalled();
  expect(
    screen.getByRole('region', { name: 'Contenu du dossier' }),
  ).toBeVisible();
});
