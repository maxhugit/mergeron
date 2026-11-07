/** Actual merge cards, synthetic GitHub observations; never starts or cancels a run. */
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { GitMerges } from './git-merges';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});
test.each([1100, 390])(
  'shows strong merge state and verified dependency at %ipx',
  async (width) => {
    await page.viewport(width, 950);
    await i18nReady;
    await i18n.changeLanguage('fr');
    document.documentElement.classList.toggle('dark', width === 1100);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let status = 'pending';
    api.mockReset().mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/merges')
          ? {
              supported: true,
              limited: false,
              inspectedAt: 1000,
              items: [
                {
                  number: 293,
                  title:
                    'Corriger la fausse alerte du terminal après reconnexion',
                  branch: 'fix/terminal-reconnect-notifications',
                  base: 'main',
                  mergedAt: '2026-10-31T10:45:17Z',
                  url: 'https://github.com/example/demo/pull/293',
                },
                {
                  number: 292,
                  title: 'Fusion courte',
                  branch: 'fix/short',
                  base: 'main',
                  mergedAt: '2026-10-31T10:00:00Z',
                  url: 'https://github.com/example/demo/pull/292',
                },
              ],
            }
          : {
              head: 'a'.repeat(40),
              limited: false,
              inspectedAt: 1000,
              url:
                'https://github.com/example/demo/commit/' +
                'a'.repeat(40) +
                '/checks',
              items: [],
              workflows: {
                available: true,
                limited: false,
                items: [
                  {
                    id: 293,
                    name: 'Build and publish Mergeron images',
                    status,
                    url: 'https://github.com/example/demo/actions/runs/293',
                    ...(status === 'pending'
                      ? {
                          waitReason: 'concurrency',
                          groups: ['mergeron-refs/heads/main'],
                          blockers: [
                            {
                              id: 292,
                              name: 'Build and publish Mergeron images',
                              status: 'in_progress',
                              pullRequest: 292,
                              url: 'https://github.com/example/demo/actions/runs/292',
                            },
                          ],
                        }
                      : {}),
                  },
                ],
              },
            },
      ),
    );
    const view = render(
      <QueryClientProvider client={client}>
        <main className="min-h-screen bg-background p-3 text-foreground">
          <div className="mx-auto flex h-[850px] max-w-sm min-h-0 flex-col rounded-lg border">
            <h1 className="border-b p-3 font-semibold">GitHub · Merges</h1>
            <GitMerges projectId="project" resourceId="connection" />
          </div>
        </main>
      </QueryClientProvider>,
    );
    try {
      const row = await screen.findByRole('button', { name: /#293 Corriger/ });
      expect(row).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Attend la fin de :')).toBeNull();
      const summaries = view.container.querySelectorAll('[data-merge-summary]');
      expect(summaries).toHaveLength(2);
      expect(summaries[0].getBoundingClientRect().height).toBe(112);
      expect(summaries[1].getBoundingClientRect().height).toBe(112);
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-merges-compact-${width}-${navigator.userAgent.includes('Chrome') ? 'chromium' : 'webkit'}.png`,
      });
      await page.getByRole('button', { name: /#293 Corriger/ }).click();
      await screen.findByText('Attend la fin de :');
      expect(screen.getByRole('link', { name: /PR #292/ })).toBeVisible();
      for (const [next, state] of [
        ['pending', 'waiting'],
        ['in_progress', 'running'],
        ['success', 'passed'],
        ['failure', 'failed'],
        ['cancelled', 'cancelled'],
      ]) {
        status = next;
        await act(async () => {
          await client.invalidateQueries({
            queryKey: ['workspace-git-merges', 'project', 'connection', 293],
          });
        });
        await expect
          .poll(() =>
            view.container
              .querySelector('[data-merge-state]')
              ?.getAttribute('data-merge-state'),
          )
          .toBe(state);
        const icon = view.container.querySelector('[data-merge-state] svg')!;
        expect(icon.getBoundingClientRect().width).toBeGreaterThanOrEqual(13);
        if (state === 'cancelled') {
          expect(icon).toHaveClass('lucide-ban');
          expect(
            view.container.querySelector('[data-merge-state="cancelled"]'),
          ).toHaveTextContent('Annulé');
        }
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
        const engine = navigator.userAgent.includes('Chrome')
          ? 'chromium'
          : 'webkit';
        await page.screenshot({
          path: `../../../.vitest-screenshots/git-merges-${engine}-${width}-${state}.png`,
        });
      }
      await page.getByRole('button', { name: /#293 Corriger/ }).click();
      expect(row).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Attend la fin de :')).toBeNull();
      expect(
        api.mock.calls.every(
          ([, options]) => !options?.method || options.method === 'GET',
        ),
      ).toBe(true);
    } finally {
      client.clear();
    }
  },
);
