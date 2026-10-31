import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelSelector } from './model-selector';
import { useModelStore } from '@/stores/model-store';
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
beforeEach(() => {
  state.admin = false;
  state.project = null;
  useModelStore.getState().clearOverrides();
});
afterEach(cleanup);
it('shows model and effort read-only for a non-administrator, without opening a picker', () => {
  render(<ModelSelector />);
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
  render(<ModelSelector />);
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByText('Alternative model'));
  expect(useModelStore.getState().modelOverride).toBe('other');
  fireEvent.click(screen.getByRole('button', { name: 'high' }));
  expect(useModelStore.getState().effortOverride).toBe('high');
});
it('withdraws an open picker after losing administrator status', () => {
  state.admin = true;
  const view = render(<ModelSelector />);
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
  render(<ModelSelector />);
  const badge = screen.getByRole('button', { name: /Defined by project/ });
  fireEvent.click(badge);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(useModelStore.getState().modelOverride).toBeNull();
});
