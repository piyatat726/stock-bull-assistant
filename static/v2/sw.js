// 台股小牛 v2 — service worker: installable app shell + offline "last known" data.
// Scope: /v2/ (served from /v2/sw.js). Bump VERSION on every shell change.
const VERSION = 'v2-2026-09-18a';
const SHELL = `shell-${VERSION}`;
const DATA = 'data-latest';
const SHELL_URLS = [
  '/v2/', '/v2/manifest.webmanifest',
  '/static/v2/css/tokens.css', '/static/v2/css/base.css', '/static/v2/css/components.css',
  '/static/v2/js/api.js', '/static/v2/js/app.js', '/static/v2/js/ui.js', '/static/v2/js/chart.js', '/static/v2/js/components.js',
  '/static/v2/js/views/home.js', '/static/v2/js/views/picks.js', '/static/v2/js/views/market.js',
  '/static/v2/js/views/portfolio.js', '/static/v2/js/views/stock.js', '/static/v2/js/views/more.js', '/static/v2/js/views/tools.js',
  '/static/v2/icons/icon-192.png', '/static/v2/icons/icon-512.png',
];
// API responses worth keeping as an offline fallback ("last known" home).
const OFFLINE_API = ['/api/market_summary', '/api/market_weather', '/api/market_breadth', '/api/sectors', '/api/top_buys', '/api/prediction_report', '/api/portfolio_get'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_URLS).catch(() => null)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k.startsWith('shell-') && k !== SHELL).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API: network-first; on failure serve last-known for whitelisted endpoints.
  if (url.pathname.startsWith('/api/')) {
    const keep = OFFLINE_API.some(p => url.pathname === p);
    e.respondWith(fetch(req).then(res => {
      if (keep && res.ok) { const copy = res.clone(); e.waitUntil(caches.open(DATA).then(c => c.put(req, copy)).catch(() => null)); }   // clone BEFORE the page consumes the body
      return res;
    }).catch(async () => {
      const hit = await caches.match(req, { cacheName: DATA });
      if (hit) { const h = new Headers(hit.headers); h.set('X-Offline', '1'); return new Response(await hit.text(), { status: 200, headers: h }); }
      return new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }));
    return;
  }

  // Shell + static + CDN chart lib: NETWORK-first (always fresh when online, no
  // stale-module surprises after a deploy), cached copy only as the offline fallback.
  const isShell = url.pathname.startsWith('/v2') || url.pathname.startsWith('/static/v2/') || url.hostname === 'unpkg.com' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (isShell) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); e.waitUntil(caches.open(SHELL).then(c => c.put(req, copy)).catch(() => null)); }   // opaque = CDN script/fonts (no-cors)
      return res;
    }).catch(async () => (await caches.match(req)) || Response.error()));
  }
});
