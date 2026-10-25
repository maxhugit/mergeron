import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  AuthRedirectError,
  AuthResourceError,
  platformSessionKey,
  readAuthResource,
  usePlatformSession,
} from './platform-session';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('recognizes a real cross-origin proxy redirect without following it to the IdP', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  await expect(
    readAuthResource('__test_proxy_redirect'),
  ).rejects.toBeInstanceOf(AuthRedirectError);
  expect(fetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ redirect: 'manual' }),
  );
});

test('keeps real HTTP denial distinct from a transient transport error', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response('', { status: 403 }),
  );
  await expect(readAuthResource('me')).rejects.toMatchObject({
    status: 403,
    name: 'AuthResourceError',
  });
});

test('recovers after pageshow with a cached identity and no workspace mounted', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const identity = {
    kind: 'person',
    personId: 'p',
    active: true,
    role: 'standard',
    name: 'Person',
  };
  client.setQueryData(platformSessionKey, identity);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(identity), {
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const hook = renderHook(() => usePlatformSession(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await act(async () => {
    await client
      .fetchQuery({
        queryKey: platformSessionKey,
        queryFn: () => {
          throw new AuthResourceError('Unavailable', 503);
        },
        retry: false,
      })
      .catch(() => {});
  });
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  act(() => window.dispatchEvent(new Event('pageshow')));
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(1);
  hook.unmount();
  client.clear();
});
