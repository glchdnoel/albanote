// 알바노트 오프라인 캐시. 파일을 고치면 VERSION을 올려주세요.
const VERSION = 'albanote-v5';
const ASSETS = ['./', './index.html', './app.js', './style.css', './manifest.webmanifest',
  './icons/icon-192-v2.png', './icons/icon-512-v2.png', './icons/apple-touch-icon-v2.png', './icons/icon-maskable-512-v2.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 같은 출처의 GET 요청만 처리: 네트워크 우선, 오프라인이면 캐시
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(m => m || caches.match('./index.html')))
  );
});
