import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HtmlViewer } from './html-viewer';
import { getFileCategory } from '@/lib/file-category';
import { useWorkspaceStore } from '@/stores/workspace-store';
import i18n, { i18nReady } from '@/i18n';
const read = vi.hoisted(() => vi.fn());
vi.mock('./preview-source', async (load) => ({
  ...(await load<typeof import('./preview-source')>()),
  fetchPreviewText: read,
}));
vi.mock('./code-viewer', () => ({
  CodeViewer: () => <div>Source editor</div>,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useWorkspaceStore.setState({ fileViews: {} });
});
async function show() {
  await i18nReady;
  await i18n.changeLanguage('en');
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <HtmlViewer
        source={{ kind: 'file', filePath: '/livrables/mockup-saved.html' }}
        viewId="saved-mockup"
        active
        readOnly
      />
    </QueryClientProvider>,
  );
}
it('recognizes both existing UUID exports and renamed HTML documents', () => {
  expect(
    getFileCategory(
      '/livrables/mockup-9ff9e344-8e51-4a96-a2d3-42b16a8bee7e.html',
    ),
  ).toBe('html');
  expect(getFileCategory('/livrables/Accueil.HTML')).toBe('html');
  expect(getFileCategory('/livrables/Accueil.htm')).toBe('html');
  expect(getFileCategory('/livrables/source.ts')).toBe('code');
});
it('opens line references in the source and stays there after navigation is consumed', async () => {
  useWorkspaceStore.setState({
    fileViews: {
      'saved-mockup': { editor: null, reveal: { line: 5, request: 1 } },
    },
  });
  await show();
  expect(await screen.findByText('Source editor')).toBeVisible();
  useWorkspaceStore.getState().consumeReveal('saved-mockup', 1);
  expect(screen.getByRole('button', { name: 'Source code' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(read).not.toHaveBeenCalled();
});
it('renders the saved bytes in an opaque sandbox and keeps the source accessible', async () => {
  const html =
    '<h1>Published revision</h1><script>window.example=true</script>';
  read.mockResolvedValue(html);
  await show();
  const frame = await screen.findByTitle('mockup-saved.html');
  expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  expect(frame.getAttribute('srcdoc')).toContain(html);
  expect(frame.getAttribute('srcdoc')).toContain("connect-src 'none'");
  fireEvent.click(screen.getByRole('button', { name: 'Source code' }));
  expect(await screen.findByText('Source editor')).toBeVisible();
  expect(screen.queryByTitle('mockup-saved.html')).toBeNull();
});
it('shows an access failure without executing an empty or stale document and allows retry', async () => {
  read
    .mockRejectedValueOnce(Error('403'))
    .mockResolvedValue('<p>Recovered</p>');
  await show();
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.queryByTitle('mockup-saved.html')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByTitle('mockup-saved.html')).toHaveAttribute(
    'sandbox',
    'allow-scripts',
  );
});
