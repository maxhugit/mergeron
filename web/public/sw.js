const STATIC_CACHE = 'mergeron-static-v6';
const STATIC_FILES = [
  './manifest.webmanifest',
  './favicon.svg',
  './pwa-icon-180.png',
  './pwa-icon-192.png',
  './pwa-icon-512.png',
  './pwa-icon-maskable-512.png',
  './mergeron-icon.svg',
  './manifest-dev.webmanifest',
  './mergeron-dev-icon.svg',
  './pwa-dev-icon-180.png',
  './pwa-dev-icon-192.png',
  './pwa-dev-icon-512.png',
  './pwa-dev-icon-maskable-512.png',
];

// Authentik redirects can be successful HTML responses. Never store them as
// manifests, icons or JavaScript: that would poison future install attempts.
function cacheableResponse(request, response) {
  const type = (response.headers.get('content-type') || '').split(';')[0];
  if (!response.ok || response.redirected || response.type !== 'basic') return false;
  if (type === 'text/html' || type === 'application/xhtml+xml') return false;
  if (new URL(request.url).pathname.endsWith('.webmanifest'))
    return type === 'application/manifest+json' || type === 'application/json';
  return /^(?:image\/|font\/|text\/css|(?:application|text)\/javascript|application\/(?:wasm|octet-stream|x-font))/.test(type);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => Promise.all(STATIC_FILES.map(async (file) => {
      const request = new Request(new URL(file, self.registration.scope), { credentials: 'include' });
      const response = await fetch(request);
      if (cacheableResponse(request, response)) await cache.put(request, response);
    }))),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('mergeron-static-') && key !== STATIC_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode === 'navigate') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache authentication, API, WebSocket, navigation, conversation or
  // file responses. Only immutable frontend assets and public PWA artwork are
  // eligible for caching.
  const isStaticAsset =
    url.pathname.startsWith(new URL('assets/', self.registration.scope).pathname) ||
    STATIC_FILES.some((file) => new URL(file, self.registration.scope).pathname === url.pathname);
  if (!isStaticAsset) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (cacheableResponse(request, response)) {
          const copy = response.clone();
          void caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});

// Only a small typed envelope is accepted. Titles, URLs and HTML supplied in a
// payload are never rendered or used as navigation targets.
function pushEnvelope(value) {
  if (!value || value.version !== 1 || typeof value.id !== 'string' || !/^[\w-]{1,128}$/.test(value.id)) return null;
  if (!['completed', 'approvals', 'questions', 'test'].includes(value.kind)) return null;
  if (value.kind !== 'test' && (typeof value.threadId !== 'string' || !/^[\w-]{1,128}$/.test(value.threadId))) return null;
  return { id: value.id, kind: value.kind, threadId: value.kind === 'test' ? null : value.threadId, language: value.language === 'fr' ? 'fr' : 'en' };
}
self.addEventListener('push', (event) => {
  let value;
  try {
    if (!event.data || event.data.text().length > 2048) return;
    value = pushEnvelope(event.data.json());
  } catch { return; }
  if (!value) return;
  const fr = value.language === 'fr';
  const title = value.kind === 'completed'
    ? (fr ? 'Mergeron — Réponse prête' : 'Mergeron — Response ready')
    : value.kind === 'test'
      ? (fr ? 'Mergeron — Notification de test' : 'Mergeron — Test notification')
      : (fr ? 'Mergeron — Votre attention est requise' : 'Mergeron — Your attention is needed');
  event.waitUntil(self.registration.showNotification(title, {
    body: fr ? 'Ouvrez Mergeron pour consulter les détails.' : 'Open Mergeron to view details.',
    icon: new URL('pwa-icon-192.png', self.registration.scope).href,
    badge: new URL('pwa-icon-192.png', self.registration.scope).href,
    tag: `mergeron:${value.id}`, renotify: false,
    data: { ...value, version: 1 },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const value = pushEnvelope(event.notification.data);
  if (!value) return;
  const scope = new URL(self.registration.scope);
  const target = new URL(value.threadId ? `t/${encodeURIComponent(value.threadId)}` : './', scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Never navigate an unrelated application or a cross-origin login window.
    const client = windows.find((item) => item.url === target) || windows.find((item) => {
      const url = new URL(item.url);
      return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
    });
    if (client) {
      if (client.url !== target) await client.navigate(target);
      await client.focus();
    } else await self.clients.openWindow(target);
  })());
});
