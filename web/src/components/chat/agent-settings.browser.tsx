import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ModelSelector } from './model-selector';
import { ServiceTierSelector } from './service-tier-selector';
import { useModelStore } from '@/stores/model-store';
import { useTimelineStore } from '@/stores/timeline-store';
import type { AgentExecutionPreferences } from '@/lib/thread-execution-preferences';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

const role = vi.hoisted(() => ({ administrator: true }));

vi.mock('@/hooks/use-current-project', () => ({
  useCurrentProject: () => undefined,
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: role.administrator }),
}));
vi.mock('@/hooks/use-active-model', () => ({
  useActiveModel: () => ({
    models: [
      {
        id: 'test-model',
        model: 'test-model',
        displayName: 'Modèle de test',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'high' },
        ],
        defaultReasoningEffort: 'low',
      },
    ],
    hiddenModels: [],
    activeModelId: 'test-model',
    configModel: 'test-model',
    activeModel: {
      model: 'test-model',
      displayName: 'Modèle de test',
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'high' },
      ],
      serviceTiers: [
        {
          id: 'priority',
          name: 'Rapide',
          description: 'Vitesse supplémentaire',
        },
      ],
      defaultServiceTier: null,
    },
  }),
}));

const clients: QueryClient[] = [];
afterEach(async () => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  useModelStore.getState().clearOverrides();
  useTimelineStore.setState({ threadId: null });
  vi.unstubAllGlobals();
  role.administrator = true;
  await i18n.changeLanguage('en');
});

test('shows saved model and effort without edit controls for a non-administrator', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  role.administrator = false;
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ revision: 1, effort: 'high' }),
  }));
  vi.stubGlobal('fetch', fetch);
  useTimelineStore.setState({ threadId: 'a' });
  mount();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: /Modèle de test.*high/ }),
    ).toBeTruthy(),
  );
  const button = screen.getByRole('button', { name: /Modèle de test.*high/ });
  expect(button.getAttribute('aria-readonly')).toBe('true');
  fireEvent.click(button);
  expect(screen.queryByRole('button', { name: 'low' })).toBeNull();
  expect(useModelStore.getState().pendingPreferencesByThread.a ?? 0).toBe(0);
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <div className="bg-background text-foreground p-6">
        <h1>Réglages de l’agent</h1>
        <ModelSelector />
        <ServiceTierSelector menuItem />
        <button onClick={() => useTimelineStore.setState({ threadId: 'b' })}>
          Agent B
        </button>
        <button onClick={() => useTimelineStore.setState({ threadId: 'a' })}>
          Agent A
        </button>
      </div>
    </QueryClientProvider>,
  );
}

test('saves through the actual selectors, survives remount and does not change another agent', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  await page.viewport(390, 760);
  const rows: Record<string, AgentExecutionPreferences> = {
    a: { revision: 1, effort: 'low', serviceTier: 'priority' },
    b: { revision: 1, effort: 'low' },
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const id = /threads\/([^/]+)/.exec(url)![1];
    if (init?.method === 'PATCH')
      rows[id] = {
        ...rows[id],
        ...JSON.parse(init.body as string),
        revision: rows[id].revision + 1,
      };
    return { ok: true, json: async () => ({ ...rows[id] }) };
  });
  vi.stubGlobal('fetch', fetch);
  useTimelineStore.setState({ threadId: 'a' });
  const view = mount();
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: /Modèle.*low/ })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: /Modèle.*low/ }));
  fireEvent.click(screen.getByRole('button', { name: 'high' }));
  await waitFor(() => expect(rows.a.effort).toBe('high'));
  fireEvent.click(screen.getByRole('button', { name: /Modèle.*high/ }));
  fireEvent.click(screen.getByRole('button', { name: /Vitesse.*Rapide/ }));
  fireEvent.click(screen.getByRole('button', { name: /Standard/ }));
  await waitFor(() => expect(rows.a.serviceTier).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Agent B' }));
  await waitFor(() =>
    expect(useModelStore.getState().preferencesByThread.b?.effort).toBe('low'),
  );
  expect(screen.getByRole('button', { name: /Modèle.*low/ })).toBeTruthy();
  expect(rows.b.serviceTier).toBeUndefined();
  view.unmount();
  useModelStore.getState().clearOverrides();
  useTimelineStore.setState({ threadId: 'a' });
  mount();
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: /Modèle.*high/ })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(
    screen.getByRole('button', { name: /Vitesse.*Standard/ }),
  ).toBeTruthy();
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH'),
  ).toHaveLength(2);
  expect(document.body.scrollWidth).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: '../../../.vitest-screenshots/agent-settings-mobile.png',
  });
});
