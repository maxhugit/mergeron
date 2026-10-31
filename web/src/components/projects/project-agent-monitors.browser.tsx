import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { page } from 'vitest/browser';
import { ProjectAutomationManager } from './project-automation-manager';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', async (original) => ({
  ...(await original<typeof import('@/lib/projects-api')>()),
  projectsApi: api,
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    isAdministrator: true,
    data: { kind: 'person' },
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    params,
    children,
  }: {
    params: { threadId: string };
    children: ReactNode;
  }) => <a href={`/t/${params.threadId}`}>{children}</a>,
}));
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

test.each([390, 1280])(
  'manages monitors without horizontal overflow at %ipx',
  async (width) => {
    await page.viewport(width, 988);
    document.documentElement.classList.toggle('dark', width === 1280);
    await i18nReady;
    await i18n.changeLanguage('fr');
    api.mockReset().mockImplementation((path?: string) => {
      if (path === undefined)
        return Promise.resolve({
          projects: [
            {
              id: 'p',
              agentThreads: [
                {
                  threadId: 'agent',
                  title: 'Contrôle de la prochaine version',
                  archived: false,
                },
              ],
            },
          ],
        });
      if (path === '/p/agent-monitors')
        return Promise.resolve({
          monitors: [
            {
              id: 'm',
              threadId: 'agent',
              name: 'Surveiller les contrôles de validation',
              instructions:
                'Vérifier les contrôles et signaler les nouveaux résultats, sans publier ni fusionner.',
              status: 'active',
              nextRunAt: Date.now() + 300_000,
              expiresAt: Date.now() + 86_400_000,
              intervalMs: 300_000,
              runCount: 2,
              maxRuns: 20,
              maxRunMs: 300_000,
              accessMode: 'readOnly',
              lastReason: 'MONITOR_USER_TAKEOVER',
            },
          ],
          activeRuns: [],
        });
      if (path === '/p/resources/r')
        return Promise.resolve({
          resource: { name: 'Automatisations' },
          targets: [],
          workspaces: [],
          transfers: [],
          automations: [],
          runs: [],
        });
      throw new Error(`Unexpected route: ${path}`);
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ProjectAutomationManager projectId="p" resourceId="r" />
      </QueryClientProvider>,
    );
    await page.getByRole('tab', { name: 'Surveillances des agents' }).click();
    await screen.findByRole('heading', {
      name: 'Surveiller les contrôles de validation',
    });
    const panel = screen.getByRole('region', {
      name: 'Surveillances des agents',
    });
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    expect(screen.getByText(/Vous pouvez continuer à parler/)).toBeVisible();
    await page.screenshot({
      path: `../../../.vitest-screenshots/monitors-list-${width}.png`,
    });
    const create = screen.getByRole('button', {
      name: 'Nouvelle surveillance',
    });
    await vi.waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const dialog = screen.getByRole('dialog');
    // Test the settled layout, not the compositor's scheduling under parallel
    // Linux/WebKit pages. Finish this finite entrance animation natively before
    // capturing, without disabling animations globally or relaxing assertions.
    for (const animation of dialog.getAnimations()) animation.finish();
    expect(Number(getComputedStyle(dialog).opacity)).toBe(1);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    expect(
      screen.getByRole('combobox', { name: 'Agent du projet' }),
    ).toHaveValue('agent');
    expect(
      screen.getByRole('checkbox', { name: /J’autorise aussi/ }),
    ).not.toBeChecked();
    await page.screenshot({
      path: `../../../.vitest-screenshots/monitors-form-${width}.png`,
    });
    dialog.scrollTop = dialog.scrollHeight;
    const submit = screen.getByRole('button', { name: 'Programmer' });
    await vi.waitFor(() =>
      expect(submit.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        dialog.getBoundingClientRect().bottom,
      ),
    );
    expect(submit.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      dialog.getBoundingClientRect().top,
    );
    if (width === 390)
      await page.screenshot({
        path: '../../../.vitest-screenshots/monitors-form-mobile-footer.png',
      });
  },
);
