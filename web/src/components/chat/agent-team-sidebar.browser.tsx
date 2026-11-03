import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { AgentTeamSidebar } from './agent-team-sidebar';
import { teamFixture } from '@/test/agent-team.fixture';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', async (original) => ({
  ...(await original<typeof import('@/lib/projects-api')>()),
  projectsApi: api,
}));
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});
test.each([390, 1280])(
  'team navigation fits %ipx and exposes each mission without starting work',
  async (width) => {
    await page.viewport(width, 988);
    await i18nReady;
    await i18n.changeLanguage('fr');
    document.documentElement.classList.toggle('dark', width === 1280);
    api
      .mockReset()
      .mockImplementation((path: string) =>
        Promise.resolve(
          path.includes('?')
            ? { teams: [teamFixture()], launchAvailable: false }
            : teamFixture(),
        ),
      );
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <div className="flex h-[850px] min-w-0">
          <AgentTeamSidebar
            projectId="p"
            coordinator="coordinator"
            open
            active
            desktop={width === 1280}
            onClose={() => {}}
          />
        </div>
      </QueryClientProvider>,
    );
    await expect
      .element(
        page.getByText('Recenser les documents existants.', { exact: true }),
      )
      .toBeVisible();
    await page.getByRole('button', { name: /^Exigences/ }).click();
    await expect
      .element(page.getByText('Douze exigences identifiées.', { exact: true }))
      .toBeVisible();
    await page.getByRole('button', { name: /^Vérification/ }).click();
    await expect
      .element(
        page.getByText('Dépend de : Sources, Exigences', { exact: true }),
      )
      .toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(screen.queryByRole('button', { name: /Lancer/ })).toBeNull();
    await page.screenshot({
      path: `../../../.vitest-screenshots/agent-team-${width}.png`,
    });
  },
);
