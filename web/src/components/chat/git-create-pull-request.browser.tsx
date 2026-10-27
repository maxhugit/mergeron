import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { GitCreatePullRequest } from './git-create-pull-request';
import type { GitSnapshot } from '@/lib/workspace-git-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects-api')>()),
  projectsApi: api,
}));
beforeEach(() => {
  api
    .mockReset()
    .mockResolvedValue({
      supported: true,
      limited: false,
      items: [{ name: 'main', revision: 'b'.repeat(40) }],
    });
});
afterEach(cleanup);
test.each([390, 1280])(
  'fits the explicit PR confirmation at %ipx without publishing automatically',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 900);
    const snapshot: GitSnapshot = {
      fingerprint: 'state',
      head: 'a'.repeat(40),
      branch: 'feature/new-layout',
      changes: [],
      branches: [],
      ahead: 0,
      behind: 0,
      upstream: null,
      inspectedAt: 1,
      branchesLimited: false,
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <GitCreatePullRequest
          projectId="p"
          copyId="copy"
          resourceId="git"
          snapshot={snapshot}
          published={{
            sha: snapshot.head,
            branch: snapshot.branch!,
            address: 'https://github.com/example/demo.git',
          }}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Créer une pull request' }),
    );
    await screen.findByRole('option', { name: 'main' });
    fireEvent.change(screen.getByLabelText('Branche cible'), {
      target: { value: 'main' },
    });
    fireEvent.change(screen.getByLabelText('Titre de la pull request'), {
      target: { value: 'Améliorer la mise en page' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Résumé des changements à relire.' },
    });
    fireEvent.click(screen.getByLabelText('Créer en brouillon'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    expect(
      within(dialog).getByRole('button', { name: 'Créer une pull request' }),
    ).toBeEnabled();
    expect(
      api.mock.calls.some(([, options]) => options?.method === 'POST'),
    ).toBe(false);
    if (width === 1280)
      await page.screenshot({
        path: '../../../.vitest-screenshots/git-create-pull-request.png',
      });
  },
);
