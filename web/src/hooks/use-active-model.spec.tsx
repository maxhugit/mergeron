import { createElement, type ReactNode } from 'react';
import { renderHook, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { useActiveModel } from './use-active-model';
import { useModelStore } from '@/stores/model-store';
const project = vi.hoisted(() =>
  vi.fn<() => { agentModel: string | null } | undefined>(),
);
vi.mock('./use-current-project', () => ({ useCurrentProject: project }));
vi.mock('@/generated/api/@tanstack/react-query.gen', () => ({
  codexStatusGetStatusOptions: () => ({
    queryKey: ['status'],
    queryFn: async () => ({}),
  }),
  modelsListModelsOptions: () => ({
    queryKey: ['models'],
    queryFn: async () => ({}),
  }),
}));
const standard = {
  model: 'server',
  serviceTiers: [],
  isDefault: true,
  hidden: false,
};
const fast = {
  model: 'project',
  serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster' }],
  isDefault: false,
  hidden: true,
};
afterEach(() => {
  cleanup();
  project.mockReset();
  useModelStore.getState().clearOverrides();
});
function mount(configModel: string | null, models = [standard, fast]) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(['status'], {
    config: { data: { model: configModel } },
    models: { defaultModel: null },
  });
  client.setQueryData(['models'], { data: models });
  return {
    client,
    ...renderHook(() => useActiveModel(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    }),
  };
}
it('resolves the project model before global overrides, including its hidden speed catalog', () => {
  project.mockReturnValue({ agentModel: 'project' });
  useModelStore.getState().setModelOverride('server');
  const { result } = mount('server');
  expect(result.current.activeModelId).toBe('project');
  expect(result.current.activeModel?.serviceTiers).toEqual(fast.serviceTiers);
  expect(useModelStore.getState().serviceTierOverride).toBeUndefined();
});
it('uses the catalog default when no model is explicitly configured', () => {
  const { result } = mount(null);
  expect(result.current.activeModelId).toBe('server');
  expect(result.current.activeModel?.model).toBe('server');
});
it('honors a local override when the project does not set a model', () => {
  project.mockReturnValue({ agentModel: null });
  useModelStore.getState().setModelOverride('project');
  const { result } = mount('server');
  expect(result.current.activeModel?.model).toBe('project');
});
it('does not silently use a different catalog for an unknown project model', () => {
  project.mockReturnValue({ agentModel: 'custom' });
  const { result } = mount('server');
  expect(result.current.activeModelId).toBe('custom');
  expect(result.current.activeModel).toBeUndefined();
});
it('recovers project speed options when the model catalog becomes available', async () => {
  project.mockReturnValue({ agentModel: 'project' });
  const { result, client } = mount('server', []);
  expect(result.current.activeModel).toBeUndefined();
  client.setQueryData(['models'], { data: [standard, fast] });
  await waitFor(() =>
    expect(result.current.activeModel?.serviceTiers).toEqual(fast.serviceTiers),
  );
});
