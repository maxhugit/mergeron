import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { AgentLaunchRecovery } from './agent-launch-recovery';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: true }),
}));
afterEach(cleanup);
test.each([390, 1280])(
  'recovers a persisted uncertain send after reload at %ipx without creating or sending again',
  async (width) => {
    await page.viewport(width, 950);
    await i18nReady;
    await i18n.changeLanguage('fr');
    api.mockReset();
    const open = vi.fn();
    const status = {
      launch: {
        id: 'receipt',
        resourceId: 'r',
        phase: 'dispatching',
        state: 'needs_attention',
        threadId: 'known-agent',
        revision: 10,
        targetRevision: 42,
        busy: false,
      },
      candidates: [],
    };
    api.mockImplementation((_path, init) =>
      Promise.resolve(init ? {} : status),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <div className="p-4">
          <AgentLaunchRecovery
            projectId="p"
            resourceId="r"
            kind="task"
            targetId="task"
            onOpen={open}
            onRecovered={() => {}}
          />
        </div>
      </QueryClientProvider>,
    );
    const confirm = await screen.findByRole('button', {
      name: 'Confirmer la vérification',
    });
    expect(confirm).toBeDisabled();
    const panel = screen.getByRole('region', {
      name: 'Reprise du lancement de l’agent',
    });
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    await page.screenshot({
      path: `../../../.vitest-screenshots/agent-launch-recovery-${width}.png`,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir l’agent' }));
    expect(open).toHaveBeenCalledExactlyOnceWith('known-agent');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(confirm);
    await expect
      .poll(
        () =>
          api.mock.calls.filter(([, init]) => init?.method === 'POST').length,
      )
      .toBe(1);
    const post = api.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(post[0]).toBe('/p/resources/r/agent-launches/receipt/recover');
    expect(JSON.parse(post[1].body)).toMatchObject({
      action: 'acknowledge',
      expectedUpdatedAt: 10,
    });
  },
);
