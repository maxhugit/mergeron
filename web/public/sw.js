const STATIC_CACHE = 'mergeron-static-v4';
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

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_FILES)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache authentication, API, WebSocket, navigation, conversation or
  // file responses. Only immutable frontend assets and public PWA artwork are
  // eligible for caching.
  const isStaticAsset =
    url.pathname.includes('/assets/') ||
    /\/(?:favicon\.svg|mergeron-(?:dev-)?icon\.svg|manifest(?:-dev)?\.webmanifest|pwa-(?:dev-)?icon-(?:180|192|512|maskable-512)\.png)$/.test(url.pathname);
  if (!isStaticAsset) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          void caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
