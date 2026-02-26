/* Offline-first service worker for GitHub Pages */
const CACHE_NAME = 'laborcurve-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/models.js',
  './js/charts.js',
  './js/utils.js',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

// Install: cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    self.skipWaiting();
  })());
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME) ? caches.delete(k) : null));
    self.clients.claim();
  })());
});

// Fetch: cache-first for same-origin; network-first for CDN (Chart.js)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Same-origin: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      const res = await fetch(event.request);
      const cache = await caches.open(CACHE_NAME);
      cache.put(event.request, res.clone());
      return res;
    })());
    return;
  }

  // CDN: network-first, then cache fallback
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request);
      const cache = await caches.open(CACHE_NAME);
      cache.put(event.request, res.clone());
      return res;
    } catch {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      throw new Error('Offline and not cached');
    }
  })());
});
