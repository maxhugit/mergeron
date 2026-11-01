import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ReloadApplicationButton } from './reload-application-button';
import { useComposerDraftStore } from '@/stores/composer-draft-store';
import { useSnackbarStore } from '@/stores/snackbar-store';

const reload = vi.hoisted(() => vi.fn());
vi.mock('@/lib/reload-application', () => ({ reloadApplication: reload }));
beforeEach(() => {
  reload.mockReset().mockImplementation(() => new Promise(() => {}));
  useComposerDraftStore.setState({ drafts: {} });
  useSnackbarStore.getState().clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('offers an accessible keyboard-operable full-app refresh button', () => {
  render(
    <TooltipProvider>
      <ReloadApplicationButton />
    </TooltipProvider>,
  );
  const button = screen.getByRole('button', { name: 'Refresh the app' });
  expect(button).toHaveAttribute('type', 'button');
  expect(button).toBeEnabled();
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
});

it('leaves unsent drafts intact when the user cancels', () => {
  useComposerDraftStore.getState().setText('thread', 'unsent text');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(
    <TooltipProvider>
      <ReloadApplicationButton />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh the app' }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().drafts.thread.text).toBe(
    'unsent text',
  );
});

it('shows cache cleanup failure and allows another attempt', async () => {
  reload.mockRejectedValue(new Error('blocked'));
  render(
    <TooltipProvider>
      <ReloadApplicationButton />
    </TooltipProvider>,
  );
  const button = screen.getByRole('button', { name: 'Refresh the app' });
  await act(async () => {
    fireEvent.click(button);
  });
  await waitFor(() =>
    expect(useSnackbarStore.getState().visible[0]?.severity).toBe('error'),
  );
  expect(button).toBeEnabled();
});

it('reloads only after explicit confirmation when drafts exist', () => {
  useComposerDraftStore.getState().setText('thread', 'unsent text');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(
    <TooltipProvider>
      <ReloadApplicationButton />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh the app' }));
  expect(reload).toHaveBeenCalledOnce();
});
