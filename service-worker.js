/* IPL Auction - service worker
 * Caches ONLY the static app shell of this site (same-origin files).
 * Everything else is left completely alone: Supabase REST/auth/RPC calls,
 * Supabase Realtime (WebSocket), live auction data.
 * To ship an update: change CACHE_VERSION below, upload, done.
 */
const CACHE_VERSION = 'v1';
const CACHE_NAME = 'ipl-auction-shell-' + CACHE_VERSION;

// Relative to the service worker file => works inside /IPL-auction-27/
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

// Pinned, versioned library the app loads from a CDN (never changes for this URL).
const SUPABASE_LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.78.0/dist/umd/supabase.min.js';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Shell files: if one is missing, install should fail so we never ship a half shell.
    await cache.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' })));
    // CDN library: best effort (opaque response is fine for <script>).
    try {
      const res = await fetch(new Request(SUPABASE_LIB, { mode: 'no-cors' }));
      await cache.put(SUPABASE_LIB, res);
    } catch (e) { /* offline during install: ignore */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('ipl-auction-shell-') && n !== CACHE_NAME)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only plain GETs. POST/RPC/auth calls are never touched.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Pinned Supabase JS library from jsDelivr: cache-first (so the shell can start offline).
  if (req.url === SUPABASE_LIB) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(SUPABASE_LIB);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        try { await cache.put(SUPABASE_LIB, res.clone()); } catch (e) {}
        return res;
      } catch (e) {
        return Response.error();
      }
    })());
    return;
  }

  // Anything cross-origin (supabase.co REST, auth, realtime, etc.) => do not intercept at all.
  if (url.origin !== self.location.origin) return;

  // Page navigations: network first (always get the newest deployed game), cached shell if offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok && url.search === '') {
          const cache = await caches.open(CACHE_NAME);
          cache.put('./index.html', res.clone()).catch(() => {});
        }
        return res;
      } catch (e) {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('./index.html', { ignoreSearch: true })) ||
               (await cache.match('./')) ||
               new Response('<h3 style="font-family:sans-serif;color:#fff;background:#101827;padding:24px">You are offline. Reconnect to join the auction.</h3>',
                            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  // Other same-origin static files (icons, manifest): cache first, refresh in background.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(req, { ignoreSearch: true });
    const refresh = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    if (hit) { refresh.catch(() => {}); return hit; }
    const res = await refresh;
    return res || new Response('', { status: 504, statusText: 'Offline' });
  })());
});
