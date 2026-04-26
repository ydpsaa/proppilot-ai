// PropPilot AI — Service Worker v2.0
const CACHE = 'proppilot-v2';
const STATIC = [
  '/',
  '/index.html',
  '/roadmap.html',
  '/manifest.json',
  '/icon.svg',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap',
];

// Install — cache static assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC.map(u => {
      try { return new Request(u, { cache: 'reload' }); } catch { return u; }
    }))).catch(() => {})
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — cache-first for static, network-first for API
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Skip APIs — always network
  if (url.hostname.includes('supabase.co') ||
      url.hostname.includes('query1.finance.yahoo.com') ||
      url.hostname.includes('groq.com')) {
    return; // fall through to network
  }

  // HTML should update immediately after deploy.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200 && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(e.request).then(cached => cached || caches.match('/index.html')))
    );
    return;
  }

  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('/index.html'));
    })
  );
});

// Push notifications
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data?.json() || {}; } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title || 'PropPilot AI', {
      body: data.body || 'New signal update',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: data.tag || 'proppilot',
      requireInteraction: data.requireInteraction || false,
      data: { url: data.url || '/index.html' },
    })
  );
});

// Notification click — open app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/index.html';
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      const existing = list.find(c => c.url.includes(url));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
