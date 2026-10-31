/** Destructive controls use synthetic API fixtures only, never a user copy. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { GitRestoreDialog } from './git-restore-dialog';
import type { GitSnapshot } from '@/lib/workspace-git-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

test.each([
  ['head', 390],
  ['head', 1180],
  ['github', 390],
  ['github', 1180],
] as const)(
  'reviews and explicitly confirms %s restoration at %ipx',
  async (target, width) => {
    await page.viewport(width, 913);
    await i18nReady;
    await i18n.changeLanguage('fr');
    document.documentElement.classList.toggle('dark', width > 390);
    const snapshot: GitSnapshot = {
      head: 'a'.repeat(40),
      branch: 'feature/local-work',
      fingerprint: 'b'.repeat(64),
      changes: [{ path: 'src/un-fichier-modifié.ts', status: 'MM' }],
      branches: [],
      inspectedAt: 1,
      ahead: 2,
      behind: 1,
      upstream: null,
      branchesLimited: false,
    };
    const review = {
      branch: snapshot.branch,
      head: snapshot.head,
      revision: target === 'head' ? snapshot.head : 'c'.repeat(40),
      reviewFingerprint: 'd'.repeat(64),
      paths: [
        'src/un-fichier-modifié.ts',
        'docs/un-autre-fichier-avec-un-nom-très-long.md',
      ],
      fileCount: 2,
      limited: false,
      localCommits: 2,
      preservedUntracked: 1,
    };
    api.mockReset().mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/branches')
          ? {
              supported: true,
              items: [{ name: 'main', revision: review.revision }],
            }
          : url.endsWith('/restore-review')
            ? review
            : {
                restored: true,
                backupBranch: 'mergeron-backup/1793449200000-12345678',
                backupRevision: 'e'.repeat(40),
              },
      ),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    try {
      render(
        <QueryClientProvider client={client}>
          <GitRestoreDialog
            projectId="p"
            copyId="copy"
            resourceId="git"
            agentThreadId="agent"
            address="https://github.com/example/demo.git"
            snapshot={snapshot}
            target={target}
            paths={
              target === 'head' ? ['src/un-fichier-modifié.ts'] : undefined
            }
            onClose={() => {}}
          />
        </QueryClientProvider>,
      );
      if (target === 'github') {
        await screen.findByRole('option', { name: /main · ccccccc/ });
        const select = screen.getByRole('combobox', {
          name: 'Branche GitHub source',
        });
        expect(select).toHaveValue('');
        fireEvent.change(select, { target: { value: 'main' } });
      }
      await page
        .getByRole('button', { name: 'Examiner l’état à restaurer' })
        .click();
      const acknowledgement = await screen.findByRole('checkbox');
      const dialog = screen.getByRole('dialog');
      for (const animation of dialog.getAnimations()) animation.finish();
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
      expect(
        screen.getByRole('button', { name: 'Confirmer le remplacement' }),
      ).toBeDisabled();
      expect(
        api.mock.calls.filter(([url]) => String(url).endsWith('/restore')),
      ).toHaveLength(0);
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-restore-${target}-${width}-review.png`,
      });
      fireEvent.click(acknowledgement);
      dialog.scrollTop = dialog.scrollHeight;
      await page
        .getByRole('button', { name: 'Confirmer le remplacement' })
        .click();
      expect(await screen.findByRole('status')).toHaveTextContent(
        'GitHub n’a pas été modifié',
      );
      expect(
        screen.getByText('mergeron-backup/1793449200000-12345678'),
      ).toBeVisible();
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      expect(
        api.mock.calls.filter(([url]) => String(url).endsWith('/restore')),
      ).toHaveLength(1);
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-restore-${target}-${width}-result.png`,
      });
    } finally {
      cleanup();
      client.clear();
    }
  },
);
