// アプリ本体: 取得できればネットワーク優先（更新を反映）、圏外ならキャッシュ
// 地理院タイル: キャッシュ優先（一度取ったものは圏外でも表示できる）
const SHELL = 'shell-v6';
const TILES = 'gsi-tiles-v1';
const TILE_HOSTS = ['cyberjapandata.gsi.go.jp', 'server.arcgisonline.com', 'ibasemaps-api.arcgis.com'];
const SHELL_FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/model.js', 'js/contour.js', 'js/areas.js', 'js/geo.js', 'js/dem.js', 'js/store.js',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css',
  'courses/index.json', 'courses/kisokoma.json', 'courses/nishisendai.json', 'data/shots.csv', 'data/sessions.json', 'sample/shots_sample.csv', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => ![SHELL, TILES].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request.url);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request.url, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin === self.location.origin) {
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
