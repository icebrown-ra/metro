/* 오프라인 캐시
 *
 * 배포할 때 CACHE 뒤의 버전만 올리면 전부 새로 받는다.
 * 음성 WAV 까지 전부 프리캐시하므로 비행기 모드에서도 그대로 동작한다.
 */
var CACHE = 'dsm-v4';

var SYLLABLES = ['1', '2', '3', '4', '5', '6', '7', '8', 'cha', 'a', 'and', 'slow', 'quick'];
var VOICE_PACKS = ['ko-heami', 'en-zira'];

var ASSETS = [
  './',
  'index.html',
  'diag.html',
  'styles.css',
  'manifest.webmanifest',
  'js/dances.js',
  'js/voices.js',
  'js/stats.js',
  'js/audio.js',
  'js/music.js',
  'js/supabase-config.js',
  'js/sync.js',
  'js/app.js',
  // js/vendor/supabase.js 는 일부러 뺀다 — 206KB 이고 로그인할 때만 필요하다.
  // 처음 쓰는 순간 런타임 캐시에 들어간다.
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

VOICE_PACKS.forEach(function (p) {
  SYLLABLES.forEach(function (s) { ASSETS.push('audio/voices/' + p + '/' + s + '.wav'); });
});

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // 파일 하나가 없어도 설치가 통째로 실패하지 않게 개별로 넣는다
      return Promise.all(ASSETS.map(function (url) {
        return c.add(url).catch(function () { });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        // 오프라인이고 캐시에도 없으면, 문서 요청은 첫 화면으로 돌린다
        if (req.mode === 'navigate') return caches.match('index.html');
        return new Response('', { status: 504 });
      });
    })
  );
});
