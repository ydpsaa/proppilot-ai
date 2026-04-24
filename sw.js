// PropPilot AI — Service Worker v1.0
const CACHE = 'proppilot-v1';
const STATIC = [
  '/',
  '/index.html',
  '/analytics.html',
  '/signal.html',
  '/roadmap.html',
  '/bot.html',
  '/manifest.json',
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

  // Skip Supabase API, TwelveData, Groq — always network
  if (url.hostname.includes('supabase.co') ||
      url.hostname.includes('twelvedata.com') ||
      url.hostname.includes('groq.com')) {
    return; // fall through to network
  }

  // Cache-first for HTML/CSS/JS
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
      icon: '/manifest.json',
      badge: '/manifest.json',
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
