// Jisste's service worker: keeps the app itself on the phone so it opens offline, and shows message alerts.
// Chats are never cached here; they always come from the server.
const VERSION = 'jisst-6';
const SHELL = ['./', 'index.html', 'css/app.css', 'css/phone.css', 'js/native.js', 'js/main.js', 'js/api.js', 'js/matrix.js', 'js/demo.js', 'js/ui.js', 'js/crypto.js', 'js/calls.js', 'js/content.js', 'js/safety.js', 'js/link.js', 'vendor/minisearch/index.js',
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
// A call rings: {kind: 'call', title, body, room, call, video} until answered, declined or ended ({kind: 'call-end'}).
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  if (d.kind === 'call') {
    e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      if (cs.some((c) => c.visibilityState === 'visible' && c.focused)) return;   // the app is open: it rings itself
      return self.registration.showNotification(d.title || 'Jisste', { body: d.body || 'Incoming call', tag: 'call:' + d.room, renotify: true, requireInteraction: true,
        vibrate: [600, 400, 600, 400, 600, 400, 600, 400, 600], icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
        actions: [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }], data: { room: d.room, call: d.call } });
    }));
    return;
  }
  if (d.kind === 'call-end') {
    e.waitUntil(self.registration.getNotifications({ tag: 'call:' + d.room }).then((ns) => {
      if (!ns.length) return;
      ns.forEach((n) => n.close());
      return self.registration.showNotification(d.title || 'Jisste', { body: `Missed ${d.video ? 'video' : 'voice'} call`, tag: 'missed:' + d.room, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { room: d.room } });
    }));
    return;
  }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    if (cs.some((c) => c.visibilityState === 'visible' && c.focused)) return;   // the app is open: it shows the message itself
    return self.registration.showNotification(d.title || 'Jisste', { body: d.body || 'New message', tag: d.room || 'jisst', renotify: true,
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { room: d.room || '' } });
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.action === 'decline') return;
  const room = e.notification.data?.room || '', call = e.action === 'answer' || (e.notification.tag || '').startsWith('call:') ? e.notification.data?.call || '' : '';
  const url = './' + (call ? `#call=${encodeURIComponent(room)}|${encodeURIComponent(call)}` : room ? '#room=' + encodeURIComponent(room) : '');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const c = cs[0];
    if (c) { c.postMessage({ jisst: 'open', room, call }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
