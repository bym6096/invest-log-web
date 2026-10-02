const CACHE = 'invest-v10';
const FILES = ['./', 'index.html', 'style.css?v=v10', 'app.js?v=v10', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (e) => {
  // cache: 'reload' — 브라우저 HTTP 캐시(GitHub Pages는 10분)를 건너뛰고 항상 최신 파일을 받는다
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(FILES.map((u) => c.add(new Request(u, { cache: 'reload' })))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// 네트워크 우선(서버에 변경 여부를 확인, 바뀐 게 없으면 304로 가볍게), 오프라인일 때만 캐시 사용
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(new Request(e.request.url, { cache: 'no-cache' })).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
