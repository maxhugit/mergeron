const RELOAD_QUERY = '__mergeron_reload';
let pending: Promise<void> | undefined;

/** Bound browser APIs: private browsing/offline workers must not hang the UI. */
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('reload-timeout')), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Clean only technical Mergeron caches. Never unregister the worker (Push),
 * clear cookies, storage or IndexedDB. Navigation is explicit, never automatic.
 */
export function reloadApplication(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    await prepareApplicationReload();
    const url = new URL(window.location.href);
    url.searchParams.set(RELOAD_QUERY, crypto.randomUUID());
    window.location.replace(url.href);
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}

export async function prepareApplicationReload(): Promise<void> {
  if ('serviceWorker' in navigator) {
    // Keep the registration/subscription. An unavailable update must not
    // prevent recovery: the existing worker never caches navigations.
    try {
      const registration = await bounded(
        navigator.serviceWorker.getRegistration(
          new URL('sw.js', document.baseURI).href,
        ),
      );
      if (registration) await bounded(registration.update());
    } catch {
      /* Offline or unsupported: still clean our caches. */
    }
  }
  if (typeof window.caches !== 'undefined') {
    const names = await bounded(caches.keys());
    await bounded(
      Promise.all(
        names
          .filter((name) => name.startsWith('mergeron-static-'))
          .map((name) => caches.delete(name)),
      ),
    );
  }
}

/** Drop only our one-shot cache-busting parameter, retaining route/search/hash. */
export function finishApplicationReload() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(RELOAD_QUERY)) return;
  url.searchParams.delete(RELOAD_QUERY);
  window.history.replaceState(window.history.state, '', url.href);
}
