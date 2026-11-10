import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DocumentGitDialog } from './document-git-dialog';
import i18n, { i18nReady } from '@/i18n';
const post = vi.hoisted(() => vi.fn());
vi.mock('@/lib/git-deliverables-api', () => ({ post }));
const options = {
  boardId: 'board',
  copyId: 'copy',
  directory: 'livrables',
  restrictedIds: [],
};
const comparison = {
  fingerprint: 'reviewed',
  version: 2,
  context: { branch: 'refs/heads/main', head: 'sha' },
  mergeron: { path: '/retained/notes.md', sha256: 'a'.repeat(64), size: 10 },
  git: {
    path: '/copy/livrables/notes.md',
    sha256: 'b'.repeat(64),
    size: 12,
    exists: true,
  },
  actions: ['mergeron', 'git'],
};
let client: QueryClient;
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  post.mockReset();
  post.mockImplementation(async (_p: string, path: string) =>
    path === '/document-preview' ? comparison : {},
  );
});
afterEach(() => {
  cleanup();
  client.clear();
});
function show() {
  const done = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <DocumentGitDialog
        projectId="p"
        documentId="doc"
        name="notes.md"
        options={options}
        onClose={() => {}}
        onDone={done}
        onFile={() => {}}
      />
    </QueryClientProvider>,
  );
  return done;
}
it('requires a second confirmation and binds the correction to this document and the reviewed fingerprint', async () => {
  const done = show();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Keep Mergeron version' }),
  );
  expect(post.mock.calls.every((call) => call[1] === '/document-preview')).toBe(
    true,
  );
  await act(async () => {
    client.setQueryData(['git-document-comparison', 'p', 'doc', options], {
      ...comparison,
      fingerprint: 'new unreviewed data',
    });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm correction' }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(post).toHaveBeenCalledWith('p', '/apply', {
    options,
    fingerprint: 'reviewed',
    resolution: {
      documentId: 'doc',
      direction: 'mergeron',
      confirmation: 'CONFIRM_DOCUMENT_RESOLUTION',
    },
  });
});
it('keeps the dialog open on a stale correction and requires refreshing the comparison', async () => {
  post.mockImplementation(async (_p: string, path: string) => {
    if (path === '/apply') throw Error('GIT_DELIVERABLES_CHANGED');
    return comparison;
  });
  const done = show();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Import Git version' }),
  );
  expect(screen.getByText(/A new version will be created/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm correction' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Refresh the comparison',
  );
  expect(done).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Check local synchronization' }),
  );
  await waitFor(() =>
    expect(
      post.mock.calls.filter((call) => call[1] === '/document-preview'),
    ).toHaveLength(2),
  );
  expect(
    screen.queryByRole('button', { name: 'Confirm correction' }),
  ).toBeNull();
});
it('offers no forced replacement when server-side protections block the document', async () => {
  post.mockResolvedValue({ ...comparison, actions: [] });
  show();
  expect(
    await screen.findByRole('button', { name: 'Keep Mergeron version' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Import Git version' }),
  ).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('protection prevents');
  expect(post.mock.calls.some((call) => call[1] === '/apply')).toBe(false);
});
