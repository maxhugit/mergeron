import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { ModelSelector } from './model-selector';
import { useModelStore } from '@/stores/model-store';
import { useTimelineStore } from '@/stores/timeline-store';
import type { AgentExecutionPreferences } from '@/lib/thread-execution-preferences';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

const role = vi.hoisted(() => ({ admin: true }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: role.admin }),
}));
vi.mock('@/hooks/use-current-project', () => ({
  useCurrentProject: () => ({
    agentModel: 'sol',
    agentReasoningEffort: 'high',
  }),
}));
vi.mock('@/generated/api/@tanstack/react-query.gen', () => ({
  codexStatusGetStatusOptions: () => ({
    queryKey: ['selector-status'],
    queryFn: () => Promise.resolve({ config: { data: { model: 'sol' } } }),
  }),
  modelsListModelsOptions: () => ({
    queryKey: ['selector-models'],
    queryFn: () =>
      Promise.resolve({
        data: [
          {
            id: 'sol',
            model: 'sol',
            displayName: 'GPT-Sol',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'medium' },
              { reasoningEffort: 'high' },
            ],
          },
          {
            id: 'luna',
            model: 'luna',
            displayName: 'GPT-Luna',
            hidden: false,
            isDefault: false,
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'high' },
            ],
          },
        ],
      }),
  }),
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  useModelStore.getState().clearOverrides();
  useTimelineStore.setState({ threadId: null });
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
});

test.each([390, 1100])(
  'administrator project model picker persists on the agent and becomes read-only without admin rights (%ipx)',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    document.documentElement.classList.add('dark');
    role.admin = true;
    useTimelineStore.setState({ threadId: 'project-agent' });
    let saved: AgentExecutionPreferences = { revision: 0 };
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/threads/project-agent/execution-preferences');
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(init.body as string);
        saved = {
          ...saved,
          ...('model' in patch ? { effort: null, serviceTier: null } : {}),
          ...patch,
          revision: saved.revision + 1,
        };
      }
      return { ok: true, json: () => Promise.resolve({ ...saved }) };
    });
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    const content = () => (
      <QueryClientProvider client={client}>
        <div className="@container/composer fixed bottom-6 left-4 right-4 rounded-2xl border bg-card p-3">
          <ModelSelector />
        </div>
      </QueryClientProvider>
    );
    const view = render(content());
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    await waitFor(() =>
      expect(screen.getByRole('button')).toHaveTextContent('GPT-Sol'),
    );
    expect(screen.getByRole('button')).toHaveTextContent('high');
    fireEvent.click(screen.getByRole('button'));
    const popup = await screen.findByRole('dialog');
    const bounds = popup.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(width);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(getComputedStyle(popup).backgroundColor).not.toBe(
      'rgba(0, 0, 0, 0)',
    );
    await page.screenshot({
      path: `../../../.vitest-screenshots/model-selector-${navigator.userAgent.includes('Chrome') ? 'chromium' : 'webkit'}-${width}.png`,
    });
    fireEvent.click(screen.getByRole('button', { name: 'GPT-Luna' }));
    await waitFor(() => expect(saved.model).toBe('luna'));
    await waitFor(() =>
      expect(screen.getByRole('button', { expanded: true })).toHaveTextContent(
        'low',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'high' }));
    await waitFor(() => expect(saved.effort).toBe('high'));
    const writes = fetch.mock.calls.filter(
      ([, init]) => init?.method === 'PATCH',
    ).length;
    role.admin = false;
    view.rerender(content());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const readonly = screen.getByRole('button');
    expect(readonly).toHaveAttribute('aria-readonly', 'true');
    expect(readonly).toHaveTextContent('GPT-Luna');
    fireEvent.click(readonly);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH'),
    ).toHaveLength(writes);
  },
);
