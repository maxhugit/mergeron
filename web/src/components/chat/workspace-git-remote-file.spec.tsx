import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceGitRemoteFile } from './workspace-git-remote-file';
import { useDocumentStore } from '@/stores/document-store';
import i18n from '@/i18n';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/lib/workspace-git-api', () => ({ gitGet: get }));
const target = {
  projectId: 'project',
  resourceId: 'repo',
  path: 'src/coucou.js',
  ref: 'a'.repeat(40),
};
const clients: QueryClient[] = [];
function show(active = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceGitRemoteFile target={target} active={active} />
    </QueryClientProvider>,
  );
}
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  get
    .mockReset()
    .mockResolvedValue({
      ref: target.ref,
      items: null,
      content: "console.log('distant');\n<script>unsafe()</script>",
    });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

it('fetches a pinned revision and displays inert, read-only text outside editable documents', async () => {
  const documents = useDocumentStore.getState().documents;
  const view = show();
  expect(await screen.findByText(/console.log/)).toHaveTextContent(
    '<script>unsafe()</script>',
  );
  expect(get).toHaveBeenCalledWith(
    'project',
    `connections/repo/files?path=src%2Fcoucou.js&ref=${target.ref}`,
    expect.any(AbortSignal),
  );
  expect(screen.getByText(/GitHub · Lecture seule/)).toBeVisible();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(
    view.container.querySelector('script, [contenteditable="true"]'),
  ).toBeNull();
  expect(useDocumentStore.getState().documents).toBe(documents);
});

it('does not request remote content while its tab is inactive', async () => {
  show(false);
  await waitFor(() => expect(screen.getByRole('status')).toBeVisible());
  expect(get).not.toHaveBeenCalled();
});

it('reports GitHub read errors without exposing editable controls', async () => {
  get.mockRejectedValue(new Error('unavailable'));
  show();
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.queryByRole('button')).toBeNull();
});

it('reports files that cannot be previewed', async () => {
  get.mockResolvedValue({ ref: target.ref, items: null, content: null });
  show();
  expect(await screen.findByText(/aperçu/i)).toBeVisible();
});
