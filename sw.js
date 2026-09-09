'use strict';

/* =========================================================================
 * OneBoard - Service Worker(PWA / オフライン用)
 *
 * ★ この SW は https 配信時(GitHub Pages など)だけ登録される。
 *   localhost / http では app.js が登録せず、古い登録を解除する。
 *
 * キャッシュ対象は「同一オリジンのアプリシェル + holidays.json」のみ。
 * ユーザーデータ(localStorage)には一切触れず、外部へも送らない。
 * Google マップ / Yahoo!乗換案内へのディープリンクは別タブへのページ遷移で
 * この SW を通らないが、fetch ハンドラでもクロスオリジンは素通しにする。
 *
 * ★ アプリ資産(html/css/js/アイコン)を変更したら CACHE のバージョンを上げること。
 *   古いキャッシュは activate 時に削除される。
 * ======================================================================= */

const CACHE = 'oneboard-v9';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './crypto.js',
  './events.js',
  './app.js',
  './tasks.js',
  './holidays.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // クロスオリジンは素通し
  if (url.pathname.includes('/__')) return;          // 死活監視パスは触らない

  // 配信データ(暗号化済み)は常に最新を優先。オフラインなら前回分。
  if (url.pathname.endsWith('/data/oneboard.enc.json')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true })),
    );
    return;
  }

  // ページ遷移: ネットワーク優先。オフラインならキャッシュのシェルを返す。
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html', { ignoreSearch: true })),
    );
    return;
  }

  // その他の資産: stale-while-revalidate(キャッシュ即返し + 背景で更新)。
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
