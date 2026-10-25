import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/terminal-store';
import { TerminalRoute } from './terminal-route';

// Exercise the real workspace and tab controls without opening a socket or PTY.
vi.mock('@/hooks/use-terminal-discovery', () => ({
  useTerminalDiscovery: vi.fn(),
}));
vi.mock('@/components/terminal/terminal-host', () => ({
  TerminalSurface: () => <div>Existing terminal surface</div>,
}));
vi.mock('@/components/terminal/terminal-status-bar', () => ({
  TerminalStatusBar: () => null,
}));

const original = useTerminalStore.getState();
const createTerminal = vi.fn().mockResolvedValue(null);

beforeEach(() => {
  sessionStorage.clear();
  createTerminal.mockClear();
  useTerminalStore.setState({
    ...original,
    contexts: {},
    terminals: {},
    createTerminal,
  });
});

afterEach(() => {
  useTerminalStore.setState(original, true);
  sessionStorage.clear();
  vi.restoreAllMocks();
});

it('opens the empty workspace on the first visit without confirmation or a new session', () => {
  render(<TerminalRoute />);
  expect(screen.getByText('No terminals')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'New terminal' })).toBeInTheDocument();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(sessionStorage.getItem('terminal.riskConfirmed')).toBeNull();
  expect(createTerminal).not.toHaveBeenCalled();
});

it('creates a terminal only after the user clicks the plus button', () => {
  render(<TerminalRoute />);
  fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
  expect(createTerminal).toHaveBeenCalledExactlyOnceWith('global', undefined);
});

it('does not depend on session storage availability or an old confirmation', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Session storage unavailable');
  });
  render(<TerminalRoute />);
  expect(screen.getByText('No terminals')).toBeInTheDocument();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(createTerminal).not.toHaveBeenCalled();
});
