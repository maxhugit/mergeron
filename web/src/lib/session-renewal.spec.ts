import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getApiToken } from '@/auth-token';
import { useSessionRenewal } from './session-renewal';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
});

it('reports a blocked popup without navigating the main window', () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const recheck = vi.fn();
  const hook = renderHook(() => useSessionRenewal(recheck));
  act(() => hook.result.current.open());
  expect(open).toHaveBeenCalledWith(
    expect.stringContaining('/login?'),
    '_blank',
    expect.any(String),
  );
  expect(hook.result.current.popupBlocked).toBe(true);
  expect(recheck).not.toHaveBeenCalled();
});

it('ignores messages from another origin or window, then asks the server to verify an authorized hint', () => {
  const popup = {
    closed: false,
    focus: vi.fn(),
    close: vi.fn(),
  } as unknown as Window;
  vi.spyOn(window, 'open').mockReturnValue(popup);
  const recheck = vi.fn();
  const hook = renderHook(() => useSessionRenewal(recheck));
  act(() => hook.result.current.open());
  const send = (
    origin: string,
    source: Window,
    type = 'mergeron:session-renewed',
  ) =>
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin,
          source,
          data: { type, token: 'new-api-jwt' },
        }),
      ),
    );
  send('https://untrusted.test', popup);
  send(window.location.origin, window);
  send(window.location.origin, popup, 'other');
  expect(recheck).not.toHaveBeenCalled();
  expect(getApiToken()).toBe('authentik-proxy');
  send(window.location.origin, popup);
  expect(recheck).toHaveBeenCalledOnce();
  expect(getApiToken()).toBe('new-api-jwt');
  hook.unmount();
  expect(popup.close).toHaveBeenCalledOnce();
});

it('bounds cookie recovery probes and never probes offline or hidden', () => {
  vi.useFakeTimers();
  const popup = { closed: true, close: vi.fn() } as unknown as Window;
  vi.spyOn(window, 'open').mockReturnValue(popup);
  const recheck = vi.fn();
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const hook = renderHook(() => useSessionRenewal(recheck));
  act(() => hook.result.current.open());
  act(() => vi.advanceTimersByTime(10_000));
  expect(recheck).not.toHaveBeenCalled();
  online.mockReturnValue(true);
  const visibility = vi
    .spyOn(document, 'visibilityState', 'get')
    .mockReturnValue('hidden');
  act(() => vi.advanceTimersByTime(5_000));
  expect(recheck).not.toHaveBeenCalled();
  visibility.mockReturnValue('visible');
  act(() => vi.advanceTimersByTime(5_000));
  expect(recheck).toHaveBeenCalledOnce();
  act(() => vi.advanceTimersByTime(120_000));
  const calls = recheck.mock.calls.length;
  act(() => vi.advanceTimersByTime(120_000));
  expect(recheck).toHaveBeenCalledTimes(calls);
  hook.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
