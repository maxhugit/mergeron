/** Fixture-only visual/interaction tests: never writes a user repository. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { GitStageChanges } from './git-stage-changes';
import { GitBranchGraph } from './git-branch-graph';
import type { GitSnapshot } from '@/lib/workspace-git-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const requests = vi.hoisted(() => [] as Array<{ url: string; body?: unknown }>);
vi.mock('@/lib/projects-api', () => ({
  projectsApi: async (url: string, options?: RequestInit) => {
    requests.push({
      url,
      body: options?.body ? JSON.parse(options.body as string) : undefined,
    });
    if (url.endsWith('/graph'))
      return {
        limited: false,
        inspectedAt: 1,
        items: [
          {
            sha: 'a'.repeat(40),
            parents: ['b'.repeat(40), 'c'.repeat(40)],
            subject: 'Fusion de la branche fonctionnelle',
            author: 'Maxime',
            date: '2026-10-27T10:00:00Z',
            current: true,
            refs: [{ name: 'main', remote: false }],
          },
          {
            sha: 'c'.repeat(40),
            parents: ['d'.repeat(40)],
            subject: 'Préparer le nouveau parcours de commit',
            author: 'Agent de travail',
            date: '2026-10-27T09:00:00Z',
            current: false,
            refs: [{ name: 'feature/commits-locaux', remote: false }],
          },
          {
            sha: 'b'.repeat(40),
            parents: ['d'.repeat(40)],
            subject: 'Correction publiée sur GitHub',
            author: 'Maxime',
            date: '2026-10-27T08:00:00Z',
            current: false,
            refs: [{ name: 'origin/main', remote: true }],
          },
          {
            sha: 'd'.repeat(40),
            parents: [],
            subject: 'Premier commit du projet',
            author: 'Maxime',
            date: '2026-10-26T08:00:00Z',
            current: false,
            refs: [],
          },
        ],
      };
    if (url.endsWith('stage-review'))
      return {
        reviewFingerprint: 'content',
        files: [
          {
            path: 'src/coucou.js',
            text: "console.log('coucou');\nconsole.log('nouvelle modification');\n",
            binary: false,
            deleted: false,
            truncated: false,
          },
        ],
      };
    if (url.endsWith('/stage') || url.endsWith('/unstage')) return {};
    throw new Error('Unexpected fixture request');
  },
}));
const snapshot: GitSnapshot = {
  fingerprint: 'index',
  branch: 'main',
  head: 'a'.repeat(40),
  changes: [
    { path: 'src/coucou.js', status: ' M' },
    {
      path: 'src/fichier-avec-un-nom-long-qui-doit-rester-lisible.js',
      status: 'M ',
    },
  ],
  branches: [],
  branchesLimited: false,
  ahead: 0,
  behind: 0,
  upstream: null,
  inspectedAt: 1,
};
afterEach(() => {
  cleanup();
  requests.splice(0);
});
test.each([390, 1100])(
  'local preparation and branch graph remain usable at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <main
          data-workflow-fixture
          className="dark min-h-screen bg-background p-3 text-foreground"
          style={{ width }}
        >
          <div className="mx-auto grid min-w-0 gap-6 md:grid-cols-2">
            <section className="min-w-0">
              <h2 className="mb-4 font-semibold">Modifications locales</h2>
              <GitStageChanges
                projectId="p"
                copyId="copy"
                agentThreadId="agent"
                snapshot={snapshot}
                writable
                onDiff={() => {}}
              />
            </section>
            <section className="min-w-0">
              <GitBranchGraph projectId="p" copyId="copy" />
            </section>
          </div>
        </main>
      </QueryClientProvider>,
    );
    try {
      await screen.findByRole('button', { name: /Fusion de la branche/ });
      await page
        .getByRole('button', { name: /Préparer le nouveau parcours de commit/ })
        .click();
      expect(
        screen.getByRole('region', { name: 'Détails du commit' }),
      ).toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-local-graph-${width}.png`,
      });
      await page.getByRole('button', { name: 'Préparer', exact: true }).click();
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('nouvelle modification');
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-stage-review-${width}.png`,
      });
      await page
        .getByRole('button', { name: 'Confirmer la préparation', exact: true })
        .click();
      await expect
        .poll(() => requests.some((r) => r.url.endsWith('/stage')))
        .toBe(true);
      expect(requests.some((r) => /\/commit$|\/push$/.test(r.url))).toBe(false);
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
