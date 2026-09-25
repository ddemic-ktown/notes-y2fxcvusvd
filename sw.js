// Service worker — offline cache for JobPilot
// Version format: na-YYYY.MM.DD-HHMM (Pacific time) — must match APP_VERSION in app.js.
const VERSION = 'na-2026.09.24-2219';
// SHELL is what the app cannot run without; EXTRAS are nice to have offline.
// They are cached separately because `cache.addAll()` is ALL-OR-NOTHING: one
// failed request out of fifteen rejects the whole promise, `install` fails, and
// the update silently never lands — it just gets retried on some later check.
// On a phone on patchy mobile data that is a very reachable state, and it is
// the most likely explanation for "the iPhone won't update". (v2026.09.24-2031)
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './js/app.js',
  './js/storage.js',
  './js/firebase-init.js',
  './js/iif.js',
  './js/files.js',
];
const EXTRAS = [
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.png',
];

// One request at a time, each allowed to fail on its own.
async function cacheEach(cache, urls, required) {
  const failed = [];
  for (const url of urls) {
    try {
      const resp = await fetch(url, { cache: 'reload' });
      if (!resp || !resp.ok) throw new Error('bad status');
      await cache.put(url, resp);
    } catch (e) {
      failed.push(url);
    }
  }
  // A missing icon is not worth refusing an update over. A missing script is:
  // activating then would leave a half-cached version that boots broken
  // offline, which is worse than staying on the old one.
  if (required && failed.length) throw new Error('shell incomplete: ' + failed.join(', '));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cacheEach(cache, SHELL, true);
    await cacheEach(cache, EXTRAS, false);   // best effort
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      // SHARE_CACHE is data in transit, not an asset cache — never sweep it.
      Promise.all(names.filter((n) => n !== VERSION && n !== 'jobpilot-share').map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Where a share is parked between the POST and the page that consumes it.
const SHARE_CACHE = 'jobpilot-share';
const shareUrl = (name) => new URL('__share/' + name, self.registration.scope).toString();

// Android's share sheet POSTs here (see share_target in manifest.json). The
// page can't read that POST body, so stash it in Cache Storage and redirect to
// the app, which picks it up on load. iOS never calls this — WebKit has not
// implemented Web Share Target.
async function handleShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    const files = form.getAll('files').filter(f => f && typeof f.size === 'number');
    for (let i = 0; i < files.length; i++) {
      await cache.put(new Request(shareUrl('file-' + i)), new Response(files[i], {
        headers: {
          'content-type': files[i].type || 'application/octet-stream',
          // encoded: header values can't carry arbitrary unicode
          'x-filename': encodeURIComponent(files[i].name || 'file'),
        },
      }));
    }
    await cache.put(new Request(shareUrl('meta')), new Response(JSON.stringify({
      title: form.get('title') || '',
      text: form.get('text') || '',
      url: form.get('url') || '',
      count: files.length,
    }), { headers: { 'content-type': 'application/json' } }));
  } catch (e) { /* fall through — the app shows "nothing to import" */ }
  // 303 so the browser follows with a GET; this is what closes the share sheet.
  return Response.redirect('./?share=1', 303);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(event.request));
    return;
  }
  if (event.request.method !== 'GET') return;

  // The app's own deploy check fetches `sw.js?ts=<now>`, a URL that has never
  // been cached — so it used to fall through and get STORED, one dead entry per
  // check, forever. On iOS that is storage pressure, and eviction there takes
  // the whole cache with it. Never cache the worker or a cache-buster.
  // (v2026.09.24-2031)
  const isVersionProbe = url.pathname.endsWith('/sw.js') || url.searchParams.has('ts');

  // Same-origin: cache-first with network fallback
  if (url.origin === location.origin) {
    if (isVersionProbe) return;              // straight to the network, uncached
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(VERSION).then((c) => c.put(event.request, clone)).catch(() => {});
          }
          return resp;
        }).catch(() => caches.match('./index.html'));
      })
    );
    return;
  }

  // Firebase SDK on gstatic — stale-while-revalidate so cold-offline still boots
  if (url.hostname === 'www.gstatic.com' && url.pathname.includes('/firebasejs/')) {
    event.respondWith(
      caches.open(VERSION).then((cache) =>
        cache.match(event.request).then((cached) => {
          const fetched = fetch(event.request).then((resp) => {
            if (resp && resp.status === 200) cache.put(event.request, resp.clone());
            return resp;
          }).catch(() => cached);
          return cached || fetched;
        })
      )
    );
  }
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
