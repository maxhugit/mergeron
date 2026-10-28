import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceGitDiff } from './workspace-git-diff';
import i18n from '@/i18n';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
vi.mock('./turn-items/git-diff-panel', () => ({
  GitDiffPanel: ({
    diff,
    initialSplit,
  }: {
    diff: string;
    initialSplit: boolean;
  }) => (
    <div data-testid="comparison" data-split={initialSplit}>
      {diff}
    </div>
  ),
}));
const target = {
  projectId: 'p',
  copyId: 'c',
  path: 'src/a b.ts',
  localPath: '/copy',
  status: ' M',
};
const onFile = vi.fn();
let client: QueryClient;
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.mockReset().mockResolvedValue({ diff: '-old\n+new', untracked: false });
  onFile.mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
});
function show(active = true, staged = false) {
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceGitDiff
        target={{ ...target, staged }}
        active={active}
        onFile={onFile}
      />
    </QueryClientProvider>,
  );
}
it('loads a split comparison, supports refresh and opens a separate editable file only explicitly', async () => {
  show();
  expect(await screen.findByTestId('comparison')).toHaveAttribute(
    'data-split',
    'true',
  );
  expect(screen.getByText('Avant · dernier commit (HEAD)')).toBeVisible();
  expect(screen.getByText('Après · copie de travail')).toBeVisible();
  expect(api.mock.calls[0][0]).toBe('/p/git/copies/c/diff?path=src%2Fa%20b.ts');
  fireEvent.click(screen.getByRole('button', { name: 'Actualiser' }));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(onFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Ouvrir le fichier' }));
  expect(onFile).toHaveBeenCalledWith('/copy/src/a b.ts');
  expect(api.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
    false,
  );
});
it('does not request hidden comparisons', () => {
  show(false);
  expect(api).not.toHaveBeenCalled();
});
it('loads only the staged version when opened from commit preparation', async () => {
  api.mockResolvedValue({ diff: '+staged only', fingerprint: 'index' });
  show(true, true);
  expect(await screen.findByTestId('comparison')).toHaveTextContent(
    '+staged only',
  );
  expect(api.mock.calls[0][0]).toBe(
    '/p/git/copies/c/staged-diff?path=src%2Fa%20b.ts',
  );
  expect(screen.getByText('Après · modifications indexées')).toBeVisible();
});
it('labels the staged-only comparison before the first commit', async () => {
  api.mockResolvedValue({ diff: '+first', untracked: false, stagedOnly: true });
  show();
  expect(await screen.findByText('Avant · dépôt sans commit')).toBeVisible();
  expect(screen.getByText('Après · modifications indexées')).toBeVisible();
});
it('shows errors rather than leaving a previously loaded comparison on screen', async () => {
  api.mockRejectedValue(new Error('unavailable'));
  show();
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.queryByTestId('comparison')).toBeNull();
});
it('explains non-textual and untracked files', async () => {
  api.mockResolvedValue({ diff: '', untracked: true });
  show();
  expect(
    await screen.findByText(
      'Nouveau fichier, pas encore suivi. Ouvrez-le pour consulter son contenu.',
    ),
  ).toBeVisible();
});
