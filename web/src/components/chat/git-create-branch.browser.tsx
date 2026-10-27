import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { GitCreateBranch } from './git-create-branch';
import type { GitSnapshot } from '@/lib/workspace-git-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects-api')>()),
  projectsApi: api,
}));
afterEach(cleanup);
test.each([390, 1307])(
  'keeps branch creation usable at %ipx without automatic publication',
  async (width) => {
    await page.viewport(width, 988);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const snapshot: GitSnapshot = {
      fingerprint: 'snapshot',
      branch: 'main',
      head: 'a'.repeat(40),
      ahead: 0,
      behind: 0,
      upstream: null,
      inspectedAt: 1,
      branchesLimited: false,
      changes: [],
      branches: [
        {
          name: 'origin/develop',
          revision: 'b'.repeat(40),
          remote: true,
          upstream: '',
          tracking: '',
        },
      ],
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <div style={{ padding: 24 }}>
          <h1>Branches locales</h1>
          <GitCreateBranch
            projectId="p"
            copyId="copy"
            snapshot={snapshot}
            readOnly={false}
          />
        </div>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Créer une branche' }));
    fireEvent.change(screen.getByLabelText('Nom de la nouvelle branche'), {
      target: { value: 'feature/nouveau-parcours' },
    });
    fireEvent.change(screen.getByLabelText('Point de départ'), {
      target: { value: 'refs/remotes/origin/develop' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    expect(
      within(dialog).getByRole('button', { name: 'Créer une branche' }),
    ).toBeVisible();
    expect(api).not.toHaveBeenCalled();
    if (width === 1307)
      await page.screenshot({
        path: '../../../.vitest-screenshots/git-create-branch.png',
      });
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(api).not.toHaveBeenCalled();
  },
);
