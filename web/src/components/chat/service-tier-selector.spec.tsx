import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ServiceTierSelector } from './service-tier-selector';
import { useModelStore } from '@/stores/model-store';
import { useAgentDisplayStore } from '@/stores/agent-display-store';
const state = vi.hoisted(() => ({
  activeModel: undefined as
    | undefined
    | {
        serviceTiers: { id: string; name: string; description: string }[];
        defaultServiceTier: string | null;
      },
}));
vi.mock('@/hooks/use-active-model', () => ({ useActiveModel: () => state }));
vi.mock('@/hooks/use-thread-execution-preferences', () => ({
  useThreadExecutionPreferences: () => ({
    preferences: undefined,
    busy: false,
    error: false,
    save: vi.fn(),
    retry: vi.fn(),
  }),
}));
afterEach(() => {
  cleanup();
  useModelStore.getState().clearOverrides();
  state.activeModel = undefined;
});
it('keeps speed visible but disabled when model options are unavailable', () => {
  render(<ServiceTierSelector menuItem />);
  expect(
    screen.getByRole('button', { name: /Speed.*Unavailable/ }),
  ).toBeDisabled();
  expect(useModelStore.getState().serviceTierOverride).toBeUndefined();
});
it('restores the advertised options as the catalog arrives without changing the chosen speed', () => {
  const view = render(<ServiceTierSelector menuItem />);
  state.activeModel = {
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster' }],
    defaultServiceTier: null,
  };
  view.rerender(<ServiceTierSelector menuItem />);
  expect(screen.getByRole('button', { name: /Speed/ })).toBeEnabled();
  expect(useModelStore.getState().serviceTierOverride).toBeUndefined();
});
it('offers advertised speed and explicit standard independently of technical details', () => {
  state.activeModel = {
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster' }],
    defaultServiceTier: null,
  };
  useAgentDisplayStore.getState().record('agent', 'hidden');
  render(<ServiceTierSelector menuItem />);
  fireEvent.click(screen.getByRole('button', { name: /Speed/ }));
  fireEvent.click(screen.getByRole('button', { name: /Fast/ }));
  expect(useModelStore.getState().serviceTierOverride).toBe('priority');
  fireEvent.click(screen.getByRole('button', { name: /Standard/ }));
  expect(useModelStore.getState().serviceTierOverride).toBeNull();
  expect(useAgentDisplayStore.getState().byThread.agent).toBe('hidden');
});
