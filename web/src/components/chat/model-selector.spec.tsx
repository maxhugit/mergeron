import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelSelector } from './model-selector';
import { useModelStore } from '@/stores/model-store';
import { useTimelineStore } from '@/stores/timeline-store';
import type { AgentExecutionPreferences } from '@/lib/thread-execution-preferences';
const state = vi.hoisted(() => ({
  admin: false,
  project: null as { agentModel: string; agentReasoningEffort: string } | null,
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: state.admin }),
}));
vi.mock('@/hooks/use-current-project', () => ({
  useCurrentProject: () => state.project,
}));
vi.mock('@/hooks/use-active-model', () => {
  const base = {
    id: 'base',
    model: 'base',
    displayName: 'Base model',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
    ],
  };
  return {
    useActiveModel: () => ({
      models: [
        base,
        {
          ...base,
          id: 'other',
          model: 'other',
          displayName: 'Alternative model',
          isDefault: false,
        },
      ],
      hiddenModels: [],
      activeModelId: 'base',
      activeModel: base,
      configModel: 'base',
    }),
  };
});
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(<ModelSelector />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
beforeEach(() => {
  state.admin = false;
  state.project = null;
  useModelStore.getState().clearOverrides();
  useTimelineStore.setState({ threadId: null });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});
it('shows model and effort read-only for a non-administrator, without opening a picker', () => {
  mount();
  const badge = screen.getByRole('button', { name: /Only administrators/ });
  expect(badge).toHaveAttribute('aria-readonly', 'true');
  expect(badge).toHaveTextContent('Base model');
  expect(badge).toHaveTextContent('medium');
  fireEvent.click(badge);
  expect(screen.queryByText('Alternative model')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(useModelStore.getState().modelOverride).toBeNull();
});
it('lets a verified administrator choose a model and reasoning effort', () => {
  state.admin = true;
  mount();
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByText('Alternative model'));
  expect(useModelStore.getState().modelOverride).toBe('other');
  fireEvent.click(screen.getByRole('button', { name: 'high' }));
  expect(useModelStore.getState().effortOverride).toBe('high');
});
it('withdraws an open picker after losing administrator status', () => {
  state.admin = true;
  const view = mount();
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByText('Alternative model')).toBeInTheDocument();
  state.admin = false;
  view.rerender(<ModelSelector />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button')).toHaveAttribute('aria-readonly', 'true');
});
it('preserves project-enforced model settings even for administrators', () => {
  state.admin = true;
  state.project = { agentModel: 'other', agentReasoningEffort: 'high' };
  mount();
  const badge = screen.getByRole('button', { name: /Defined by project/ });
  fireEvent.click(badge);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(useModelStore.getState().modelOverride).toBeNull();
});

it('lets an administrator save choices on the selected agent without writing legacy overrides', async () => {
  state.admin = true;
  useTimelineStore.setState({ threadId: 'agent-a' });
  let saved: AgentExecutionPreferences = { revision: 1, effort: 'high' };
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const patch = JSON.parse(init.body as string);
      saved = {
        ...saved,
        ...('model' in patch ? { effort: null, serviceTier: null } : {}),
        ...patch,
        revision: saved.revision + 1,
      };
    }
    return { ok: true, json: async () => ({ ...saved }) };
  });
  vi.stubGlobal('fetch', fetch);
  mount();
  await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByText('Alternative model'));
  await waitFor(() =>
    expect(
      useModelStore.getState().preferencesByThread['agent-a'],
    ).toMatchObject({
      model: 'other',
      effort: null,
      serviceTier: null,
    }),
  );
  const mutations = fetch.mock.calls.filter(
    ([, init]) => init?.method === 'PATCH',
  );
  expect(mutations).toHaveLength(1);
  expect(mutations[0][0]).toBe('/api/threads/agent-a/execution-preferences');
  expect(JSON.parse(mutations[0][1]!.body as string)).toEqual({
    model: 'other',
  });
  expect(useModelStore.getState().modelOverride).toBeNull();
  expect(useModelStore.getState().effortOverride).toBeNull();
});

it('reads saved agent choices for non-administrators without issuing a settings mutation', async () => {
  useTimelineStore.setState({ threadId: 'agent-a' });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/threads/agent-a/execution-preferences');
    expect(init?.method).toBe('GET');
    return {
      ok: true,
      json: async () => ({ revision: 1, effort: 'high' }),
    };
  });
  vi.stubGlobal('fetch', fetch);
  mount();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: /Only administrators/ }),
    ).toHaveTextContent('high'),
  );
  fireEvent.click(screen.getByRole('button', { name: /Only administrators/ }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalled();
  expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(
    true,
  );
});
