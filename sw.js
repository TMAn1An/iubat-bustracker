// Service worker: makes the student app installable and quick to open.
// - /vendor/* (versioned libraries that never change): cache first.
// - Pages and app files: network first, so an update is live at once; the cached copy is used only when offline.
// - /api/*, map tiles and anything else from other sites: never cached here (always live).
const VERSION = 'v1';
const SHELL = ['/', '/index.html', '/css/style.css', '/js/feed.js', '/js/map.js', '/js/bus3d.js', '/js/share.js', '/js/app.js',
  '/vendor/maplibre-gl.js', '/vendor/maplibre-gl.css', '/vendor/three.min.js', '/assets/logo.png', '/assets/icons/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/vendor/')) {
    e.respondWith(caches.match(e.request).then(c => c || fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSION).then(x => x.put(e.request, copy)); return r; })));
    return;
  }
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('/') : Response.error()))));
});
