import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AuthResourceError,
  AuthRedirectError,
  AUTH_REQUEST_TIMEOUT_MS,
  SESSION_RECOVERY_INTERVAL_MS,
  SESSION_CHECK_INTERVAL_MS,
  isSessionTransportError,
  platformSessionKey,
  readAuthResource,
  shouldRetryPlatformSession,
  usePlatformSession,
} from './platform-session';
import {
  installSessionRecovery,
  isSessionPaused,
  pauseSession,
} from './session-recovery';

let disposeRecovery: () => void;
beforeEach(() => {
  disposeRecovery = installSessionRecovery();
});

afterEach(() => {
  disposeRecovery();
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
        await vi.advanceTimersByTimeAsync(SESSION_CHECK_INTERVAL_MS * 3);
      });
      expect(hook.result.current.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      hook.unmount();
      client.clear();
    },
  );

  it('shares wake-up checks and polling across mounted consumers, retaining recovery when a child leaves', async () => {
    vi.useFakeTimers();
    disposeRecovery();
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('visible');
    const identity = {
      kind: 'person',
      personId: 'original',
      role: 'administrator',
      active: true,
    };
    const response = () =>
      new Response(JSON.stringify(identity), {
        headers: { 'Content-Type': 'application/json' },
      });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => response());
    disposeRecovery = installSessionRecovery();
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const parent = renderHook(() => usePlatformSession(), { wrapper });
    const child = renderHook(() => usePlatformSession(), { wrapper });
    await act(async () => {
      await parent.result.current.refetch();
    });
    network.mockClear();
    visibility.mockReturnValue('hidden');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    let finish!: (value: Response) => void;
    network.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    visibility.mockReturnValue('visible');
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(network).toHaveBeenCalledTimes(1);
    expect(parent.result.current.paused).toBe(true);
    expect(parent.result.current.isAdministrator).toBe(false);
    child.unmount();
    await act(async () => {
      finish(response());
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(parent.result.current.paused).toBe(false);
    network.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    expect(network).toHaveBeenCalledTimes(1);
    parent.unmount();
    network.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(network).not.toHaveBeenCalled();
    client.clear();
  });

  it('does not throttle a newly required verification behind an older in-flight focus check', async () => {
    vi.useFakeTimers();
    disposeRecovery();
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('visible');
    const identity = {
      kind: 'person',
      personId: 'original',
      role: 'administrator',
      active: true,
    };
    const response = (personId = 'original') =>
      new Response(JSON.stringify({ ...identity, personId }), {
        headers: { 'Content-Type': 'application/json' },
      });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => response());
    disposeRecovery = installSessionRecovery();
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    const hook = renderHook(() => usePlatformSession(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });
    await act(async () => {
      await hook.result.current.refetch();
    });
    visibility.mockReturnValue('hidden');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    network.mockClear();
    let oldFinish!: (value: Response) => void;
    let freshFinish!: (value: Response) => void;
    network.mockReturnValueOnce(
      new Promise((resolve) => {
        oldFinish = resolve;
      }),
    );
    network.mockReturnValueOnce(
      new Promise((resolve) => {
        freshFinish = resolve;
      }),
    );
    visibility.mockReturnValue('visible');
    act(() => window.dispatchEvent(new Event('focus')));
    expect(network).toHaveBeenCalledTimes(1);
    expect(isSessionPaused()).toBe(false);
    const oldSignal = network.mock.calls[0][1]?.signal;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    act(() => window.dispatchEvent(new Event('focus')));
    expect(network).toHaveBeenCalledTimes(2);
    expect(oldSignal?.aborted).toBe(true);
    expect(isSessionPaused()).toBe(true);
    await expect(
      fetch('/api/projects', { method: 'POST' }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(network).toHaveBeenCalledTimes(2);
    await act(async () => {
      freshFinish(response());
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(hook.result.current.paused).toBe(false);
    await act(async () => {
      oldFinish(response('changed'));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(hook.result.current.data?.personId).toBe('original');
    expect(hook.result.current.paused).toBe(false);
    hook.unmount();
    client.clear();
  });
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

  it('only rechecks a proxy redirect when this tab already verified its owner', () => {
    expect(shouldRetryPlatformSession(0, new AuthRedirectError())).toBe(false);
    expect(shouldRetryPlatformSession(0, new AuthRedirectError(), true)).toBe(
      true,
    );
    expect(shouldRetryPlatformSession(3, new AuthRedirectError(), true)).toBe(
      false,
    );
    for (const status of [401, 403, 409])
      expect(
        shouldRetryPlatformSession(
          0,
          new AuthResourceError('Denied', status),
          true,
        ),
      ).toBe(false);
  });

  it('requires a new identity response when an in-flight verification predates the pause', async () => {
    vi.useFakeTimers();
    const identity = {
      kind: 'person',
      personId: 'original',
      active: true,
      role: 'standard',
      name: 'Person',
    };
    const response = () =>
      new Response(JSON.stringify(identity), {
        headers: { 'Content-Type': 'application/json' },
      });
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    client.setQueryData(platformSessionKey, identity);
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => response());
    const hook = renderHook(() => usePlatformSession(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });
    await act(async () => {
      await hook.result.current.refetch();
    });
    let finish!: (value: Response) => void;
    network.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    let pending: ReturnType<typeof hook.result.current.refetch> | undefined;
    act(() => {
      pending = hook.result.current.refetch();
    });
    act(() => {
      pauseSession();
    });
    await act(async () => {
      finish(response());
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(hook.result.current.paused).toBe(true);
    expect(network).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await pending;
    });
    expect(network).toHaveBeenCalledTimes(3);
    expect(hook.result.current.paused).toBe(false);
    hook.unmount();
    client.clear();
  });

  it.each(['original', 'changed', 'expired'])(
    'bounds proxy recovery and only resumes the freshly verified original owner: %s',
    async (result) => {
      vi.useFakeTimers();
      const identity = {
        kind: 'person',
        personId: 'original',
        active: true,
        role: 'standard',
        name: 'Person',
      };
      const response = (value: unknown) =>
        new Response(JSON.stringify(value), {
          headers: { 'Content-Type': 'application/json' },
        });
      const client = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity } },
      });
      client.setQueryData(platformSessionKey, identity);
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => response(identity));
      const hook = renderHook(() => usePlatformSession(), {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(QueryClientProvider, { client }, children),
      });
      await act(async () => {
        await hook.result.current.refetch();
      });
      expect(hook.result.current.paused).toBe(false);
      network.mockClear();
      const redirect = { type: 'opaqueredirect', status: 0 } as Response;
      network
        .mockResolvedValueOnce(redirect)
        .mockImplementation(async () =>
          result === 'expired'
            ? redirect
            : response({ ...identity, personId: result }),
        );
      let pending: ReturnType<typeof hook.result.current.refetch> | undefined;
      await act(async () => {
        pending = hook.result.current.refetch();
        await vi.advanceTimersByTimeAsync(1);
      });
      // Cached data grants no access during retry; a brief outage is not yet
      // presented as a confirmed expiration requiring interactive login.
      expect(hook.result.current.paused).toBe(true);
      expect(hook.result.current.isError).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
        await pending;
      });
      expect(network).toHaveBeenCalledTimes(result === 'expired' ? 4 : 2);
      expect(hook.result.current.paused).toBe(result !== 'original');
      expect(hook.result.current.isSuccess).toBe(result === 'original');
      if (result === 'changed')
        expect(hook.result.current.error?.name).toBe(
          'AuthIdentityChangedError',
        );
      if (result === 'expired')
        expect(hook.result.current.error).toBeInstanceOf(AuthRedirectError);
      hook.unmount();
      client.clear();
    },
  );

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

  it('does not open a login window automatically after a proxy redirect', async () => {
    const open = vi.spyOn(window, 'open');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      type: 'opaqueredirect',
      status: 0,
    } as Response);
    const client = new QueryClient();
    const hook = renderHook(() => usePlatformSession(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });
    await waitFor(() =>
      expect(hook.result.current.error).toBeInstanceOf(AuthRedirectError),
    );
    expect(hook.result.current.paused).toBe(true);
    expect(hook.result.current.isAdministrator).toBe(false);
    expect(open).not.toHaveBeenCalled();
    hook.unmount();
    client.clear();
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
