import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  SILENT_RENEWAL_TIMEOUT_MS,
  useSilentSessionRenewal,
} from './silent-session-renewal';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const frame = () =>
  document.querySelector<HTMLIFrameElement>('iframe[title="Session renewal"]')!;
function hint(status = 'complete', overrides: Record<string, unknown> = {}) {
  const target = frame();
  const request = new URL(target.src).searchParams.get('request');
  act(() =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: target.contentWindow,
        data: { type: 'mergeron:silent-renewal', request, status },
        ...overrides,
      }),
    ),
  );
}

it('starts invisibly, validates the sender and request, then requires a fresh verification', async () => {
  const open = vi.spyOn(window, 'open');
  const recheck = vi.fn(async () => true);
  const hook = renderHook(() => useSilentSessionRenewal(true, 2, recheck));
  await act(async () => {});
  expect(hook.result.current).toBe('running');
  expect(frame().hidden).toBe(true);
  expect(frame().getAttribute('sandbox')).toBe(
    'allow-scripts allow-same-origin allow-forms',
  );
  hint('complete', { origin: 'https://untrusted.test' });
  hint('complete', { source: window });
  hint('complete', {
    data: {
      type: 'mergeron:silent-renewal',
      request: 'wrong',
      status: 'complete',
    },
  });
  expect(recheck).not.toHaveBeenCalled();
  hint();
  await waitFor(() => expect(hook.result.current).toBe('idle'));
  expect(recheck).toHaveBeenCalledOnce();
  expect(frame()).toBeNull();
  expect(open).not.toHaveBeenCalled();
  hook.unmount();
});

it.each(['interactive', 'unavailable'])(
  'reports %s without granting access or navigating',
  async (status) => {
    const recheck = vi.fn(async () => true);
    const hook = renderHook(() => useSilentSessionRenewal(true, 3, recheck));
    await act(async () => {});
    hint(status);
    expect(hook.result.current).toBe(status);
    expect(recheck).not.toHaveBeenCalled();
    expect(frame()).toBeNull();
    hook.unmount();
  },
);

it('bounds an unresponsive or blocked IdP and never loops within the same generation', async () => {
  vi.useFakeTimers();
  const recheck = vi.fn(async () => false);
  const hook = renderHook(
    ({ generation }) => useSilentSessionRenewal(true, generation, recheck),
    { initialProps: { generation: 3 } },
  );
  await act(async () => {});
  act(() => vi.advanceTimersByTime(SILENT_RENEWAL_TIMEOUT_MS));
  expect(hook.result.current).toBe('unavailable');
  expect(frame()).toBeNull();
  hook.rerender({ generation: 3 });
  expect(frame()).toBeNull();
  hook.rerender({ generation: 4 });
  await act(async () => {});
  expect(frame()).not.toBeNull();
  hook.unmount();
  expect(frame()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not resume when the identity verification fails, even after a valid hint', async () => {
  const recheck = vi.fn(async () => false);
  const hook = renderHook(() => useSilentSessionRenewal(true, 8, recheck));
  await act(async () => {});
  hint();
  await waitFor(() => expect(hook.result.current).toBe('unavailable'));
  expect(recheck).toHaveBeenCalledOnce();
  hook.unmount();
});

it('does not start for disabled, offline, or hidden recovery and cleans up on unmount', () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const hook = renderHook(() => useSilentSessionRenewal(true, 0, vi.fn()));
  expect(frame()).toBeNull();
  hook.unmount();
  vi.restoreAllMocks();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const hidden = renderHook(() => useSilentSessionRenewal(true, 1, vi.fn()));
  expect(frame()).toBeNull();
  hidden.unmount();
  vi.restoreAllMocks();
  const disabled = renderHook(() => useSilentSessionRenewal(false, 0, vi.fn()));
  expect(frame()).toBeNull();
  disabled.unmount();
});

it('survives StrictMode effect replay without leaving two renewal frames', async () => {
  const verify = vi.fn(async () => true);
  const hook = renderHook(() => useSilentSessionRenewal(true, 10, verify), {
    reactStrictMode: true,
  });
  await act(async () => {});
  expect(
    document.querySelectorAll('iframe[title="Session renewal"]'),
  ).toHaveLength(1);
  hint();
  await waitFor(() => expect(hook.result.current).toBe('idle'));
  expect(verify).toHaveBeenCalledOnce();
  hook.unmount();
  expect(frame()).toBeNull();
});
