import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  acceptVerifiedSession,
  installSessionRecovery,
  isSessionPaused,
  pauseSession,
} from './session-recovery';
import type { PlatformSession } from './platform-session';
import { configureApiClient } from '@/api-client';
import { client } from '@/generated/api/client.gen';
import { filesGetMetadata } from '@/generated/api';
import { useSnackbarStore } from '@/stores/snackbar-store';

const identity: PlatformSession = {
  kind: 'person',
  personId: 'one',
  name: 'Person',
  role: 'administrator',
  active: true,
};
let dispose: () => void;
let network: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  network = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', network);
  dispose = installSessionRecovery();
});
afterEach(() => {
  dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('blocks custom and generated API mutations until fresh identity verification, never queues them', async () => {
  await expect(
    fetch('/api/projects', { method: 'POST', body: '{}' }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(network).not.toHaveBeenCalled();
  expect(acceptVerifiedSession(identity)).toBe(true);
  await fetch('/api/projects');
  expect(network).toHaveBeenCalledTimes(1);
  pauseSession();
  await expect(
    fetch('/api/projects/p', { method: 'DELETE' }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  acceptVerifiedSession(identity);
  expect(network).toHaveBeenCalledTimes(1);
});

it('also gates the real generated client without showing a misleading error notification', async () => {
  configureApiClient();
  client.setConfig({ baseUrl: window.location.origin });
  useSnackbarStore.getState().clear();
  await expect(
    filesGetMetadata({ query: { path: '/work/file' }, throwOnError: true }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(network).not.toHaveBeenCalled();
  expect(useSnackbarStore.getState().visible).toEqual([]);
});

it('keeps login and identity probes reachable but not auth administration or similar prefixes', async () => {
  for (const path of ['me', 'methods']) await fetch(`/api/auth/${path}`);
  for (const path of ['login', 'local-login'])
    await fetch(`/api/auth/${path}`, { method: 'POST' });
  expect(network).toHaveBeenCalledTimes(4);
  await expect(fetch('/api/auth/local-accounts')).rejects.toThrow();
  await expect(fetch('/api/auth/me/other')).rejects.toThrow();
  await expect(fetch('/api/auth/me', { method: 'PATCH' })).rejects.toThrow();
});

it.each([
  { personId: 'other' },
  { role: 'standard' as const },
  { active: false },
  {
    impersonation: {
      sessionId: 'test',
      administratorId: 'admin',
      administratorName: 'Admin',
      personId: 'one',
      personName: 'Person',
      expiresAt: 1,
    },
  },
])('refuses a changed or inactive identity: %j', (changes) => {
  acceptVerifiedSession(identity);
  pauseSession();
  expect(acceptVerifiedSession({ ...identity, ...changes })).toBe(false);
  expect(isSessionPaused()).toBe(true);
  expect(acceptVerifiedSession(identity)).toBe(true);
});

it('closes the gate on idle return before other focus handlers can submit a mutation', async () => {
  vi.useFakeTimers();
  acceptVerifiedSession(identity);
  vi.advanceTimersByTime(31_000);
  let attempt: Promise<Response> | undefined;
  const other = () => {
    attempt = fetch('/api/projects', { method: 'POST' });
  };
  window.addEventListener('focus', other);
  window.dispatchEvent(new Event('focus'));
  window.removeEventListener('focus', other);
  await expect(attempt).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
  expect(isSessionPaused()).toBe(true);
});

it('does not mistake a descendant focus event for returning to the window', () => {
  vi.useFakeTimers();
  acceptVerifiedSession(identity);
  vi.advanceTimersByTime(31_000);
  const input = document.createElement('input');
  document.body.append(input);
  const paused = vi.fn();
  window.addEventListener('codex-webui:session-paused', paused);
  try {
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(isSessionPaused()).toBe(false);
    expect(paused).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('codex-webui:session-paused', paused);
    input.remove();
  }
});

it.each([401, 302])(
  'treats HTTP %s as a session failure without following a redirect',
  async (status) => {
    acceptVerifiedSession(identity);
    network.mockResolvedValueOnce(new Response('', { status }));
    const expired = vi.fn();
    window.addEventListener('codex-webui:auth-expired', expired);
    await expect(fetch('/api/projects')).rejects.toThrow();
    window.removeEventListener('codex-webui:auth-expired', expired);
    expect(network).toHaveBeenCalledWith('/api/projects', {
      redirect: 'manual',
    });
    expect(expired).toHaveBeenCalledOnce();
    expect(isSessionPaused()).toBe(true);
  },
);

it('discards a response started before the session was paused, even after recovery', async () => {
  acceptVerifiedSession(identity);
  let finish!: (response: Response) => void;
  network.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const response = fetch('/api/projects');
  pauseSession();
  acceptVerifiedSession(identity);
  finish(new Response('{}'));
  await expect(response).rejects.toMatchObject({ name: 'AbortError' });
});

it.each([401, 302])(
  'does not let an old HTTP %s invalidate a renewed session',
  async (status) => {
    acceptVerifiedSession(identity);
    let finish!: (response: Response) => void;
    network.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const oldRequest = fetch('/api/projects');
    pauseSession();
    acceptVerifiedSession(identity);
    const expired = vi.fn();
    window.addEventListener('codex-webui:auth-expired', expired);
    try {
      finish(new Response('', { status }));
      await expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' });
      expect(expired).not.toHaveBeenCalled();
      expect(isSessionPaused()).toBe(false);
    } finally {
      window.removeEventListener('codex-webui:auth-expired', expired);
    }
  },
);

it('does not interfere with external or static resources', async () => {
  await fetch('https://example.test/api/resource');
  await fetch('/assets/file.js');
  expect(network).toHaveBeenCalledTimes(2);
});
