import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  finishApplicationReload,
  reloadApplication,
} from './reload-application';

const replace = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const registration = vi.fn();
const keys = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('location', {
    href: 'http://localhost:3000/t/agent?panel=files#anchor',
    replace,
  });
  registration.mockResolvedValue({ update });
  update.mockResolvedValue(undefined);
  keys.mockResolvedValue([
    'mergeron-static-v5',
    'mergeron-static-v6',
    'other-app',
  ]);
  remove.mockResolvedValue(true);
  vi.stubGlobal('caches', { keys, delete: remove });
  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistration: registration },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('updates the worker, removes only owned caches, then requests fresh HTML preserving route', async () => {
  localStorage.setItem('preferences', 'kept');
  sessionStorage.setItem('session', 'kept');
  await reloadApplication();
  expect(update).toHaveBeenCalledOnce();
  expect(remove.mock.calls.map(([name]) => name)).toEqual([
    'mergeron-static-v5',
    'mergeron-static-v6',
  ]);
  const url = new URL(replace.mock.calls[0][0]);
  expect(url.pathname).toBe('/t/agent');
  expect(url.searchParams.get('panel')).toBe('files');
  expect(url.hash).toBe('#anchor');
  expect(url.searchParams.get('__mergeron_reload')).toBeTruthy();
  expect(localStorage.getItem('preferences')).toBe('kept');
  expect(sessionStorage.getItem('session')).toBe('kept');
  expect(update.mock.invocationCallOrder[0]).toBeLessThan(
    remove.mock.invocationCallOrder[0],
  );
  expect(remove.mock.invocationCallOrder[1]).toBeLessThan(
    replace.mock.invocationCallOrder[0],
  );
});

it('coalesces repeated clicks and continues after an unavailable worker update', async () => {
  update.mockRejectedValue(new Error('offline'));
  const first = reloadApplication();
  expect(reloadApplication()).toBe(first);
  await first;
  expect(replace).toHaveBeenCalledOnce();
});

it('does not navigate on cache failure and permits retry', async () => {
  keys.mockRejectedValueOnce(new Error('storage blocked'));
  await expect(reloadApplication()).rejects.toThrow('storage blocked');
  expect(replace).not.toHaveBeenCalled();
  await reloadApplication();
  expect(replace).toHaveBeenCalledOnce();
});

it('bounds a hung worker update', async () => {
  vi.useFakeTimers();
  update.mockReturnValue(new Promise(() => {}));
  const operation = reloadApplication();
  await vi.advanceTimersByTimeAsync(3001);
  await operation;
  expect(replace).toHaveBeenCalledOnce();
});

it('bounds hung cache cleanup without navigating', async () => {
  vi.useFakeTimers();
  remove.mockReturnValue(new Promise(() => {}));
  const operation = reloadApplication();
  const failed = expect(operation).rejects.toThrow('reload-timeout');
  await vi.advanceTimersByTimeAsync(3001);
  await failed;
  expect(replace).not.toHaveBeenCalled();
});

it('works without service worker or CacheStorage support', async () => {
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('caches', undefined);
  await reloadApplication();
  expect(replace).toHaveBeenCalledOnce();
});

it('removes only the reload marker on boot without changing history state', () => {
  vi.stubGlobal('location', {
    href: 'http://localhost:3000/base/t/a?panel=files&__mergeron_reload=nonce#anchor',
  });
  const history = vi
    .spyOn(window.history, 'replaceState')
    .mockImplementation(() => {});
  finishApplicationReload();
  expect(history).toHaveBeenCalledWith(
    window.history.state,
    '',
    'http://localhost:3000/base/t/a?panel=files#anchor',
  );
});
