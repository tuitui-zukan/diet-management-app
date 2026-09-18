/*
 * オフラインでもアプリを開けるようにするためのキャッシュ。
 * データ自体（localStorage）はキャッシュと無関係で、常に端末に残る。
 */
const CACHE_NAME = "dietapp-cache-v2";
const FILES_TO_CACHE = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ネットワークが使えるときは常に最新版を取りに行き、キャッシュはオフライン時の保険として使う
// （キャッシュ優先にすると、コードを更新してもスマホ側がいつまでも古い版を表示し続けてしまうため）
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
