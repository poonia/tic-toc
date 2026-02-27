/**
 * service-worker.js — Offline-first caching strategy
 *
 * Strategy: Cache-First for app shell, Network-First for navigations.
 * On install:  pre-cache all app shell assets.
 * On fetch:    serve from cache if available; fall back to network.
 * On activate: clean up old cache versions.
 */

const CACHE_VERSION = 'tictac-v1';

// App shell — all files needed to run offline
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './sync.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // Google Fonts — attempt to cache, skip if offline during install
];

// ── Install: pre-cache app shell ────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[sw] Install:', CACHE_VERSION);

  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      // Cache must-have files (will fail install if these miss)
      return cache.addAll(PRECACHE_URLS.filter(url => !url.includes('fonts.googleapis')));
    }).then(() => {
      // Skip waiting — activate immediately
      return self.skipWaiting();
    })
  );
});

// ── Activate: delete old caches ─────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[sw] Activate:', CACHE_VERSION);

  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_VERSION)
          .map(name => {
            console.log('[sw] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first strategy ─────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin WebRTC/API requests
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // For navigation requests, use network-first (to get latest version)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache fresh response
          const cloned = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(request, cloned));
          return response;
        })
        .catch(() => {
          // Offline — serve cached page
          return caches.match('./index.html');
        })
    );
    return;
  }

  // For all other assets: cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      // Not in cache — fetch and optionally cache
      return fetch(request).then((response) => {
        // Only cache same-origin successful responses
        if (response.ok && url.origin === self.location.origin) {
          const cloned = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(request, cloned));
        }
        return response;
      }).catch(() => {
        // Resource offline and not cached — return empty 503
        return new Response('Offline', {
          status: 503,
          statusText: 'Service Unavailable',
        });
      });
    })
  );
});

// ── Background sync (future enhancement) ─────────────────────────
self.addEventListener('sync', (event) => {
  console.log('[sw] Background sync:', event.tag);
  // Could be used to flush queued moves when network resumes
});
