/* オフライン用。常にネットワーク優先で、つながらない時だけ保存済みを使う */
const CACHE = 'nanoha-techo-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'img/nanoha-photo.jpg', 'img/tutu.png', 'img/tiara.png', 'img/ballerina.png', 'img/bear.png',
  'img/pointe-shoes.png', 'img/swan.png', 'icons/apple-touch-icon.png', 'icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('catalog.json')) return; // アプリ側で毎回取得・キャッシュ
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
