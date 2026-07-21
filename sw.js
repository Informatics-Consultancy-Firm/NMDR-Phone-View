// ============================================================
//  National Malaria Data Repository (NMDR) · Service Worker
//  BUMP THIS VERSION every time you upload new files:
const CACHE_VERSION = 'nmdr-v1';
// ============================================================

// App shell — cached at install so the portal opens offline.
const APP_FILES = [
  './',
  './index.html',
  './offline.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  // images used on the welcome screen
  './mohlogo.png',
  './nmdr_info.png',
];

// Google Fonts stylesheet (font files cache at runtime on first load).
const CDN_FILES = [
  'https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap',
];

// NEVER cache — always go to the live network.
// (Google Apps Script backend + the embedded Google Slides + any DHIS2 host.)
const NEVER_CACHE = ['script.google.com', 'docs.google.com', 'googleusercontent.com'];

// External origins allowed to be cached at runtime (fonts only).
const CACHE_EXTERNAL = ['fonts.googleapis.com', 'fonts.gstatic.com'];

function toAbs(url){ return url.startsWith('http') ? url : new URL(url, self.location.href).href; }

async function cacheOne(cache, url){
  try {
    const req = new Request(url, { cache: 'reload' });
    const res = await fetch(req);
    if (res && (res.status === 200 || res.type === 'opaque')) await cache.put(req, res);
  } catch (e) { console.warn('[SW] skipped', url, e.message); }
}

// ── INSTALL ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async cache => {
      await Promise.all([...APP_FILES, ...CDN_FILES].map(u => cacheOne(cache, toAbs(u))));
      return self.skipWaiting();
    })
  );
});

// ── ACTIVATE ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── FETCH: cache-first, then network (and cache same-origin pages as visited) ──
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;

  // Live backend / embeds always hit the network.
  if (NEVER_CACHE.some(p => url.includes(p))) return;

  const isExternal = !url.startsWith(self.location.origin);
  const isAllowed = CACHE_EXTERNAL.some(o => new URL(url).hostname.includes(o));
  if (isExternal && !isAllowed) return; // ignore other externals (don't cache)

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request)
        .then(r => {
          // cache same-origin files (sub-pages, images) as they're first opened
          if (r && (r.status === 200 || r.type === 'opaque')) {
            const copy = r.clone();
            caches.open(CACHE_VERSION).then(c => c.put(event.request, copy));
          }
          return r;
        })
        .catch(() => {
          if (event.request.mode === 'navigate')
            return caches.match(toAbs('./offline.html')) || caches.match(toAbs('./index.html'));
          return new Response('', { status: 503 });
        });
    })
  );
});

// ── MESSAGES ──
self.addEventListener('message', event => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data.type === 'CLEAR_CACHE') caches.delete(CACHE_VERSION);
});
