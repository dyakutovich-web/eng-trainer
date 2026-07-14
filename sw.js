/* SW v4 (US-06): network-first с кеш-фолбэком — свежий код доезжает сразу, офлайн работает.
   Установка кеширует ассеты по одному (отсутствие одного файла не валит установку). */
const CACHE = 'evt-v8';
const ASSETS = [
  './index.html',
  './css/styles.css',
  './js/engine.js',
  './js/app.js',
  './data/seed.json',
  './data/items_extra.json',
  './data/items_generated.json',
  './data/preps.json',
  './data/items_chunks_extra.json',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() =>
      caches.match(e.request).then(hit => hit || caches.match('./index.html'))
    )
  );
});
