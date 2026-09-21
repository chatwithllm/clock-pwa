// sw.js — cache-first app shell; network-first w/ cache fallback for Open-Meteo.
// Registers only over HTTPS/localhost (browsers block SW on plain-http LAN IPs).

const SHELL = 'clockpwa-shell-v27';
const RUNTIME = 'clockpwa-runtime-v27';

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/clock.js',
  './js/weather.js',
  './js/wakelock.js',
  './js/nav.js',
  './js/settings.js',
  './js/weatherfx.js',
  './js/sunarc.js',
  './js/feelcolor.js',
  './js/source.js',
  './js/alertview.js',
  './js/calendar-banner.js',
  './js/appversion.js',
  './js/presence.js',
  './js/ha.js',
  './js/ha-protocol.js',
  './js/ha-dashboard.js',
  './js/dashboard-view.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES).catch(()=>{})).then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter((k) => k !== SHELL && k !== RUNTIME);
    // Old clockpwa caches present => this is an upgrade, not a first install.
    const upgraded = stale.some((k) => k.startsWith('clockpwa-'));
    await Promise.all(stale.map((k) => caches.delete(k)));
    await self.clients.claim();
    if (upgraded){
      // An open page keeps running the JS it already loaded, so an always-on
      // display would show the old build until someone reloads it. Reload the
      // windows this worker controls now that the new shell is in place.
      const wins = await self.clients.matchAll({ type: 'window' });
      wins.forEach((c) => { try { c.navigate(c.url); } catch (_) {} });
    }
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Server config / weather / announcements / profiles / source / ZIP geocoder: network-first, cache fallback.
  if (url.pathname === '/config.json' || url.pathname === '/weather.json'
      || url.pathname === '/announce.json' || url.pathname === '/profiles.json'
      || url.pathname === '/source.json' || url.pathname === '/alerts.json'
      || url.pathname === '/dashboards.json'
      || url.pathname === '/version.json'
      || url.hostname.endsWith('zippopotam.us')){
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(RUNTIME).then((c) => c.put(req, copy)).catch(()=>{});
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Open-Meteo: network-first, fall back to runtime cache.
  if (url.hostname.endsWith('open-meteo.com')){
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(RUNTIME).then((c) => c.put(req, copy)).catch(()=>{});
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Uploaded media: immutable filenames — cache-first, populate runtime cache.
  if (url.pathname.startsWith('/uploads/')){
    e.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(RUNTIME).then((c) => c.put(req, copy)).catch(()=>{});
        return res;
      }))
    );
    return;
  }

  // App shell: cache-first, fall back to network.
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      // Runtime-cache same-origin GETs opportunistically.
      if (url.origin === self.location.origin){
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(req, copy)).catch(()=>{});
      }
      return res;
    }).catch(() => cached))
  );
});
