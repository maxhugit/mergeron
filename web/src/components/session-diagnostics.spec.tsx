import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionDiagnostics } from './session-diagnostics';
import {
  clearSessionDiagnostics,
  getSessionDiagnostics,
  recordSessionDiagnostic,
} from '@/lib/session-diagnostics';

afterEach(() => {
  cleanup();
  clearSessionDiagnostics();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('exposes local evidence and downloads it without a network request, then can clear it', () => {
  vi.useFakeTimers();
  const create = vi.fn(() => 'blob:synthetic-diagnostic');
  const revoke = vi.fn();
  class LocalURL extends URL {
    static createObjectURL = create;
    static revokeObjectURL = revoke;
  }
  vi.stubGlobal('URL', LocalURL);
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {});
  recordSessionDiagnostic('check_failed', {
    reason: 'server_unavailable',
    status: 503,
    durationMs: 80,
  });
  render(<SessionDiagnostics />);
  fireEvent.click(screen.getByText('Connection diagnostic'));
  expect(screen.getByRole('log')).toHaveTextContent('HTTP 503');
  expect(screen.getByRole('log')).toHaveTextContent('80 ms');
  fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic' }));
  expect(create).toHaveBeenCalledOnce();
  expect(click).toHaveBeenCalledOnce();
  expect(network).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1000));
  expect(revoke).toHaveBeenCalledWith('blob:synthetic-diagnostic');
  fireEvent.click(
    screen.getByRole('button', { name: 'Clear this diagnostic' }),
  );
  expect(getSessionDiagnostics()).toHaveLength(0);
  expect(screen.getByRole('log')).toHaveTextContent('No recorded event.');
});
