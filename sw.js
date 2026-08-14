// SnapDraft Service Worker v1
// Caches the app shell for offline use

const CACHE_NAME = 'snapdraft-v6';
const CACHE_URLS = [
  '/',
  '/index.html',
];

// On install — cache the app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  );
  self.skipWaiting();
});

// On activate — clean up old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// On fetch — network first, fall back to cache
// Network first means you always get fresh data (picks, rankings, etc.)
// but if offline, the last cached version loads instantly
self.addEventListener('fetch', e => {
  // Only handle GET requests for same-origin or our CDN assets
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Clean-route navigations (/teamreview, /calc, …) map to the single app
  // shell. Go network-first (so 404.html's redirect still runs online), but
  // fall back to the cached shell so deep links also work offline.
  if (e.request.mode === 'navigate') {
    // cache:'reload' bypasses the browser's HTTP cache so a fresh deploy of
    // index.html is fetched from the network every navigation, not served stale
    // from GitHub Pages' ~10-min max-age. Fall back to the cached shell offline.
    e.respondWith(
      fetch(new Request(e.request.url, { cache: 'reload', credentials: 'same-origin' }))
        .then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put('/index.html', clone)).catch(()=>{});
          }
          return res;
        })
        .catch(() => caches.match('/index.html').then(r => r || caches.match('/')))
    );
    return;
  }

  // Always go network-first for API calls (Sleeper, FantasyCalc, etc.)
  const isAPI = url.hostname.includes('sleeper') ||
                url.hostname.includes('fantasycalc') ||
                url.hostname.includes('rosteraudit') ||
                url.hostname.includes('fantasypros');

  if (isAPI) return; // Let API calls go direct — don't intercept

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Cache successful responses for the app shell
        if (res.ok && (url.pathname.endsWith('.html') || url.pathname === '/')) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
