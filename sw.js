// Service worker for the Mictobystar apps (Windows and Android). It keeps the POS page and its files on the device,
// so the app opens without internet. Shop data is not handled here: the page keeps its own copy and syncs it.
const V = 'mb-shell-v1';
const SHELL = ['/pos', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/logo-icon.svg', '/logo.svg', '/logo-white.svg'];
const LIBS = ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(V);
    await Promise.all(SHELL.map(u => fetch(u, { cache: 'reload' }).then(r => { if (r.ok) return c.put(u, r); }).catch(() => {})));
    await Promise.all(LIBS.map(u => fetch(u, { mode: 'cors' }).then(r => { if (r.ok) return c.put(u, r); }).catch(() => {})));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== V) await caches.delete(k);
    await self.clients.claim();
  })());
});

// The page: the newest copy from the website when it answers within a few seconds, otherwise the copy kept on the device.
async function pageFirst(req) {
  const c = await caches.open(V);
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(req, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (r.ok) { c.put('/pos', r.clone()); return r; }
    if (r.status < 500) return r;
  } catch (e) {}
  return (await c.match('/pos')) || new Response('<meta charset="utf-8"><body style="font:16px system-ui;padding:24px;text-align:center"><h2>No internet connection</h2><p>Open Mictobystar once with internet on this device. After that it also works offline.</p><button onclick="location.reload()">Try again</button>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
// Files that rarely change: the copy on the device first, refreshed in the background.
async function cacheFirst(req, key) {
  const c = await caches.open(V), hit = await c.match(key || req);
  const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(key || req, r.clone()); return r; });
  if (hit) { net.catch(() => {}); return hit; }
  return net;
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === self.location.origin) {
    if (u.pathname.startsWith('/api/') || u.pathname === '/sw.js') return; // always the live server
    if (req.mode === 'navigate' || u.pathname === '/pos' || u.pathname.startsWith('/pos/')) return e.respondWith(pageFirst(req));
    if (SHELL.includes(u.pathname)) return e.respondWith(cacheFirst(req, u.pathname));
    if (u.pathname.startsWith('/img/')) return e.respondWith(cacheFirst(req)); // product photos
    return;
  }
  if (/cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(u.hostname)) e.respondWith(cacheFirst(req));
});
