// Jisst's service worker: keeps the app itself on the phone so it opens offline, and shows message alerts.
// Chats are never cached here; they always come from the server.
const VERSION = 'jisst-2';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/main.js', 'js/api.js', 'js/matrix.js', 'js/demo.js', 'js/ui.js', 'js/crypto.js', 'js/calls.js', 'vendor/minisearch/index.js',
  'agents/index.js', 'agents/jisst.js', 'agents/grandprix.js', 'agents/wire.js', 'agents/reminders.js', 'icons/icon.svg', 'icons/icon-192.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// The app's own files: network first so updates arrive at once, the saved copy when offline. Everything else passes through.
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname.startsWith('/_matrix/')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((r) => r || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});

// A message alert. The gateway sends only who it is from and a short preview: {title, body, room}.
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    if (cs.some((c) => c.visibilityState === 'visible' && c.focused)) return;   // the app is open: it shows the message itself
    return self.registration.showNotification(d.title || 'Jisst', { body: d.body || 'New message', tag: d.room || 'jisst', renotify: true,
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { room: d.room || '' } });
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const room = e.notification.data?.room || '', url = './' + (room ? '#room=' + encodeURIComponent(room) : '');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const c = cs[0];
    if (c) { c.postMessage({ jisst: 'open', room }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
