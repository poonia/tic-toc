/**
 * service-worker.js — Offline-first PWA caching
 *
 * Strategy:
 *   INSTALL  → Pre-cache every local app-shell asset. Fails loudly if any
 *              local file is missing (catches typos in PRECACHE_URLS).
 *              Google Fonts are cached opportunistically — not required.
 *
 *   ACTIVATE → Delete any old cache versions immediately.
 *              Claim all open tabs so the new SW takes effect right away.
 *
 *   FETCH    → Cache-first for ALL requests:
 *                1. Check cache → return immediately if found
 *                2. Fetch from network → cache the response → return it
 *                3. If both fail (offline + not cached) → return offline page
 *              This ensures the app works fully offline after first load.
 *
 * Bump CACHE_NAME whenever you change any app file to force re-install.
 */

const CACHE_NAME = 'tictac-v4';

/* Every local file the app needs to run offline */
const PRECACHE = [
  './index.html',
  './paper.css',
  './style.css',
  './app.js',
  './db.js',
  './sync.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/* Google Fonts URLs to cache opportunistically (best-effort) */
const FONT_ORIGINS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

/* ── INSTALL ─────────────────────────────────────────────────────
   Pre-cache all local app-shell files.
   skipWaiting() activates this SW immediately without waiting for
   existing tabs to close.
─────────────────────────────────────────────────────────────────*/
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch((err) => {
        console.error('[sw] Pre-cache failed:', err);
        throw err; // Abort install so Chrome retries next time
      })
  );
});

/* ── ACTIVATE ────────────────────────────────────────────────────
   Remove all old caches. clients.claim() makes this SW immediately
   control any open pages without needing a reload.
─────────────────────────────────────────────────────────────────*/
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ── FETCH ───────────────────────────────────────────────────────
   Cache-first strategy for all GET requests.
─────────────────────────────────────────────────────────────────*/
self.addEventListener('fetch', (event) => {
  const { request } = event;

  /* Only intercept GET requests */
  if (request.method !== 'GET') return;

  /* Skip chrome-extension and non-http(s) URLs */
  if (!request.url.startsWith('http')) return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isFont = FONT_ORIGINS.some((h) => url.hostname.includes(h));

  /* Skip WebRTC STUN requests and other non-cacheable cross-origin */
  if (!isSameOrigin && !isFont) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {

      /* 1. Try cache first */
      const cached = await cache.match(request);
      if (cached) return cached;

      /* 2. Not in cache — fetch from network */
      try {
        const response = await fetch(request);

        /* Cache valid same-origin responses and font responses */
        if (response.ok && (isSameOrigin || isFont)) {
          cache.put(request, response.clone());
        }

        return response;
      } catch (_networkError) {

        /* 3. Offline and not cached */
        if (request.mode === 'navigate') {
          /* Navigation: serve the cached app shell */
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }

        /* All else: return a minimal offline response */
        return new Response('Offline — resource not cached yet.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    })
  );
});
