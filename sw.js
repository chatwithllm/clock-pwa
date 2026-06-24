// sw.js — cache-first app shell; network-first w/ cache fallback for Open-Meteo.
// Registers only over HTTPS/localhost (browsers block SW on plain-http LAN IPs).

const SHELL = 'clockpwa-shell-v13';
const RUNTIME = 'clockpwa-runtime-v13';

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
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))
    )).then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Server config / weather / announcements / profiles / ZIP geocoder: network-first, cache fallback.
  if (url.pathname === '/config.json' || url.pathname === '/weather.json'
      || url.pathname === '/announce.json' || url.pathname === '/profiles.json'
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
