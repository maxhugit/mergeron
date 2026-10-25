import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AuthResourceError,
  AuthRedirectError,
  AUTH_REQUEST_TIMEOUT_MS,
  SESSION_RECOVERY_INTERVAL_MS,
  isSessionTransportError,
  platformSessionKey,
  readAuthResource,
  renewProxySession,
  shouldRetryPlatformSession,
  usePlatformSession,
} from './platform-session';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  cleanup();
  sessionStorage.clear();
});

describe('platform session recovery', () => {
  it('recovers a transient failure when returning after two hours in a hidden tab', async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    const identity = {
      active: true,
      kind: 'person',
      personId: 'person',
      role: 'administrator',
      name: 'Person',
    };
    client.setQueryData(platformSessionKey, identity);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(identity), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const hook = renderHook(() => usePlatformSession(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });
    await act(async () => {
      await client
        .fetchQuery({
          queryKey: platformSessionKey,
          queryFn: () => {
            throw new AuthResourceError('Restarting', 503);
          },
          retry: false,
        })
        .catch(() => {});
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(hook.result.current.isError).toBe(true);
    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pageshow'));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(hook.result.current.isSuccess).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    hook.unmount();
    client.clear();
  });
  it('rechecks identity after server downtime without any focus or online event', async () => {
    vi.useFakeTimers();
    const identity = {
      kind: 'person',
      personId: 'person',
      active: true,
      role: 'administrator',
      name: 'Person',
    };
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    client.setQueryData(platformSessionKey, identity);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify(identity), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const hook = renderHook(() => usePlatformSession(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });
    await act(async () => {
      await client
        .fetchQuery({
          queryKey: platformSessionKey,
          queryFn: () => {
            throw new AuthResourceError('Restarting', 503);
          },
          retry: false,
        })
        .catch(() => {});
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(hook.result.current.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_RECOVERY_INTERVAL_MS + 1);
    });
    expect(hook.result.current.isSuccess).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.method).toBeUndefined();
    hook.unmount();
    client.clear();
  });

  it.each([401, 403])(
    'does not poll a real HTTP %s refusal as a restart',
    async (status) => {
      vi.useFakeTimers();
      const client = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity } },
      });
      client.setQueryData(platformSessionKey, { active: true });
      const fetch = vi.spyOn(globalThis, 'fetch');
      const hook = renderHook(() => usePlatformSession(), {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(QueryClientProvider, { client }, children),
      });
      await act(async () => {
        await client
          .fetchQuery({
            queryKey: platformSessionKey,
            queryFn: () => {
              throw new AuthResourceError('Denied', status);
            },
            retry: false,
          })
          .catch(() => {});
        await vi.advanceTimersByTimeAsync(SESSION_RECOVERY_INTERVAL_MS * 2);
      });
      expect(hook.result.current.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      hook.unmount();
      client.clear();
    },
  );
  it('retries transient transport failures up to three times', () => {
    const networkError = new TypeError('Load failed');

    expect(shouldRetryPlatformSession(0, networkError)).toBe(true);
    expect(shouldRetryPlatformSession(2, networkError)).toBe(true);
    expect(shouldRetryPlatformSession(3, networkError)).toBe(false);
  });

  it('does not retry an expired or forbidden session', () => {
    expect(
      shouldRetryPlatformSession(0, new AuthResourceError('Unauthorized', 401)),
    ).toBe(false);
    expect(
      shouldRetryPlatformSession(0, new AuthResourceError('Forbidden', 403)),
    ).toBe(false);
  });

  it('retries temporary HTTP failures', () => {
    expect(
      shouldRetryPlatformSession(
        0,
        new AuthResourceError('Service unavailable', 503),
      ),
    ).toBe(true);
  });

  it('requests transport recovery when the browser fetch fails locally', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new TypeError('Load failed'),
    );
    const dispatch = vi.spyOn(window, 'dispatchEvent');

    await expect(readAuthResource('me')).rejects.toThrow('Load failed');

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex-webui:transport-recover' }),
    );
  });

  it('does not follow a proxy login redirect with the API authorization header', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      type: 'opaqueredirect',
      status: 0,
    } as Response);
    await expect(readAuthResource('me')).rejects.toBeInstanceOf(
      AuthRedirectError,
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/me',
      expect.objectContaining({
        redirect: 'manual',
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(shouldRetryPlatformSession(0, new AuthRedirectError())).toBe(false);
  });

  it('also recognizes a visible 302 without consuming its login HTML', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      status: 302,
    } as Response);
    await expect(readAuthResource('me')).rejects.toBeInstanceOf(
      AuthRedirectError,
    );
  });

  it('does not accept an HTML login page as an identity', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html>Login</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    await expect(readAuthResource('me')).rejects.toThrow('did not return JSON');
  });

  it.each([401, 403])(
    'preserves a real HTTP %s denial without recovery navigation',
    async (status) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('', { status }),
      );
      const dispatch = vi.spyOn(window, 'dispatchEvent');
      await expect(readAuthResource('me')).rejects.toMatchObject({
        name: 'AuthResourceError',
        status,
      });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it('reads a valid JSON identity and releases its deadline', async () => {
    vi.useFakeTimers();
    const identity = { active: true, personId: 'person' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(identity), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
    );
    await expect(readAuthResource('me')).resolves.toEqual(identity);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a stalled request after browser sleep', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const result = expect(readAuthResource('me')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the deadline active until a stalled response body is read', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      async (_url, init) =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(init.signal?.reason),
              );
            }),
        }) as Response,
    );
    const result = expect(readAuthResource('me')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates query cancellation without triggering transport recovery', async () => {
    const controller = new AbortController();
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const result = expect(
      readAuthResource('me', controller.signal),
    ).rejects.toThrow();
    controller.abort();
    await result;
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps denial separate from connection failures', () => {
    expect(isSessionTransportError(new TypeError('Load failed'))).toBe(true);
    expect(
      isSessionTransportError(new AuthResourceError('Unavailable', 503)),
    ).toBe(true);
    expect(
      isSessionTransportError(new AuthResourceError('Forbidden', 403)),
    ).toBe(false);
    expect(
      isSessionTransportError(new AuthResourceError('Unauthorized', 401)),
    ).toBe(false);
    expect(isSessionTransportError(new AuthRedirectError())).toBe(false);
    expect(isSessionTransportError(null)).toBe(false);
  });

  it('limits automatic browser navigation to one per five minutes', () => {
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    expect(renewProxySession(1_000_000)).toBe(true);
    expect(renewProxySession(1_000_001)).toBe(false);
    expect(renewProxySession(1_300_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not automatically navigate without persistent loop protection', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage blocked');
    });
    expect(renewProxySession()).toBe(false);
  });

  it('recovers a failed cached identity on pageshow even without a workspace mounted', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const identity = {
      kind: 'person',
      personId: 'person',
      active: true,
      role: 'administrator',
      name: 'Person',
    };
    client.setQueryData(platformSessionKey, identity);
    // A 503 exhausts session retries immediately here, without waiting through backoff.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 503 }),
    );
    const hook = renderHook(() => usePlatformSession(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });
    await act(async () => {
      await client
        .fetchQuery({
          queryKey: platformSessionKey,
          queryFn: () => {
            throw new AuthResourceError('Forbidden', 403);
          },
          retry: false,
        })
        .catch(() => {});
    });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(hook.result.current.data?.active).toBe(true); // stale cache must not grant workspace access
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(identity), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => window.dispatchEvent(new Event('pageshow')));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('pageshow'));
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    hook.unmount();
    act(() => window.dispatchEvent(new Event('pageshow')));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    client.clear();
  });
});
