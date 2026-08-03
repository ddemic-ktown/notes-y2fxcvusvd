// Service worker — offline cache for JobPilot
// Version format: na-YYYY.MM.DD-HHMM (Pacific time) — must match APP_VERSION in app.js.
const VERSION = 'na-2026.08.02-2214';
const CORE = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './js/app.js',
  './js/storage.js',
  './js/firebase-init.js',
  './js/iif.js',
  './js/files.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting())
  );
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

  // Same-origin: cache-first with network fallback
  if (url.origin === location.origin) {
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
