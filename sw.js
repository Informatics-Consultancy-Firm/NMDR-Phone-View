/* NMDR Portal service worker
   Offline first. Pages are served from cache so the portal opens with no
   network. New versions arrive only when the user presses Update.

   Edit PRECACHE below to match the files sitting beside index.html.
*/

const APP_VERSION   = 'nmdr-2026-07-25b';
const SHELL_CACHE   = 'nmdr-shell-' + APP_VERSION;
const RUNTIME_CACHE = 'nmdr-runtime';

/* Files fetched and stored the moment the portal is first opened. */
const PRECACHE = [
  './',
  './index.html',
  './nmdr-offline.js',
  './mohlogo.png',
  './nmdr_info.png',
  './sbd.html',
  './mocm_phu.html',
  './mocm_hospital.html',
  './warehouse.html'
];

/* Cross origin hosts whose files are safe to keep for offline use.
   Everything else cross origin (DHIS2, Apps Script) always goes to the
   network and is never stored. */
const CACHEABLE_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com'
];

/* ---------------------------------------------------------------- install */

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One at a time so a single missing file cannot fail the whole install.
    for (const url of PRECACHE) {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok) await cache.put(url, res);
      } catch (e) { /* file not present yet, runtime caching will pick it up */ }
    }
  })());
});

/* --------------------------------------------------------------- activate */

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n.startsWith('nmdr-shell-') && n !== SHELL_CACHE)
        .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------------ fetch */

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (!sameOrigin && !CACHEABLE_HOSTS.includes(url.hostname)) {
    return; // DHIS2, Apps Script and any other API: straight to the network
  }

  event.respondWith(cacheFirst(req, sameOrigin));
});

async function cacheFirst(req, sameOrigin) {
  const shell = await caches.open(SHELL_CACHE);
  const hit = await shell.match(req, { ignoreSearch: sameOrigin });
  if (hit) return hit;

  const runtime = await caches.open(RUNTIME_CACHE);
  const runtimeHit = await runtime.match(req);
  if (runtimeHit) return runtimeHit;

  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      runtime.put(req, res.clone());
    }
    return res;
  } catch (e) {
    if (req.mode === 'navigate') {
      const fallback = await shell.match('./index.html');
      if (fallback) return fallback;
    }
    return new Response(
      'Offline and this file has not been saved to the device yet.',
      { status: 503, headers: { 'Content-Type': 'text/plain' } }
    );
  }
}

/* --------------------------------------------------------------- messages */

self.addEventListener('message', event => {
  const data = event.data || {};
  const reply = msg => {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(msg);
  };

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'GET_VERSION') {
    reply({ type: 'VERSION', version: APP_VERSION });
    return;
  }

  if (data.type === 'REFRESH_CONTENT') {
    // Always reply, including on failure, or the page waits for the timeout.
    event.waitUntil(
      refreshContent().then(reply, function (err) {
        reply({ type: 'REFRESH_DONE', updated: 0, failed: [], error: String(err && err.message || err) });
      })
    );
  }
});

/* Re-download every same origin file already held, plus the precache list,
   bypassing the browser HTTP cache. This is what the Update button runs. */
async function refreshContent() {
  const shell   = await caches.open(SHELL_CACHE);
  const runtime = await caches.open(RUNTIME_CACHE);

  const targets = new Map(); // url -> cache holding it

  for (const url of PRECACHE) {
    targets.set(new URL(url, self.location).href, shell);
  }
  for (const cache of [shell, runtime]) {
    for (const req of await cache.keys()) {
      if (new URL(req.url).origin === self.location.origin) {
        targets.set(req.url, cache);
      }
    }
  }

  let updated = 0;
  const failed = [];

  for (const [url, cache] of targets) {
    try {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (res.ok) {
        await cache.put(url, res);
        updated++;
      } else {
        failed.push(url + ' (' + res.status + ')');
      }
    } catch (e) {
      failed.push(url);
    }
  }

  return { type: 'REFRESH_DONE', updated, failed, version: APP_VERSION };
}
