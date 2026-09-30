/* eslint-disable no-undef */
/**
 * SERVICE WORKER — application shell caching
 * ==========================================
 *
 * Strategy:
 *   - Precache the application shell (HTML, manifest, icons, CSS, JS bundles).
 *   - Navigations: network-first with a cache fallback so a new deploy is picked
 *     up, but an offline launch still boots.
 *   - Static assets: cache-first, then network, with the response cached.
 *   - Generated sectors are NEVER cached. They are reconstructable from the world
 *     seed plus the save payload, so there is nothing procedural to pre-cache.
 *
 * The cache is versioned; activating a new version clears the old one.
 */

const VERSION = 'terminus-harmonic-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

const SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individual failures must not abort the install.
      await Promise.allSettled(SHELL_URLS.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') {
    void self.skipWaiting();
    return;
  }
  // The page tells us which hashed bundles it actually loaded. Their names
  // change every build, so they cannot be in the static SHELL_URLS list; without
  // this the very first visit is not yet offline-capable.
  if (event.data && event.data.type === 'cache-assets') {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        await Promise.allSettled(
          (event.data.urls || []).map(async (url) => {
            try {
              if (await cache.match(url)) return;
              const res = await fetch(url, { cache: 'reload' });
              if (res && res.ok) await cache.put(url, res);
            } catch {
              /* an asset that will not fetch is simply not cached */
            }
          }),
        );
      })(),
    );
  }
});

function isAsset(url) {
  return /\.(?:js|mjs|css|png|jpg|jpeg|webp|svg|woff2?|json|wasm)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first so deploys are picked up, cache fallback offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          const hit =
            (await cache.match('./index.html')) ||
            (await cache.match('./')) ||
            (await cache.match(req));
          if (hit) return hit;
          return new Response(
            '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
              '<body style="background:#05060a;color:#d6d2c8;font-family:monospace;padding:24px">' +
              '<h1>The Terminus Harmonic</h1><p>The application shell is not cached yet. ' +
              'Reconnect once to enable offline play.</p></body>',
            { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          );
        }
      })(),
    );
    return;
  }

  if (isAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const hit = await cache.match(req);
        if (hit) {
          // Revalidate in the background.
          event.waitUntil(
            fetch(req)
              .then((res) => {
                if (res && res.ok) cache.put(req, res.clone());
              })
              .catch(() => undefined),
          );
          return hit;
        }
        try {
          const res = await fetch(req);
          if (res && res.ok && res.type !== 'opaque') cache.put(req, res.clone());
          return res;
        } catch {
          return new Response('', { status: 504, statusText: 'offline' });
        }
      })(),
    );
  }
});
