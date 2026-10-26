const STATIC_CACHE = 'mergeron-static-v5';
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
