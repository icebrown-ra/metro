/* 오프라인 캐시
 *
 * 전략이 두 가지로 나뉜다.
 *
 *   코드(html·css·js·매니페스트) — 네트워크 우선, 2.5초 안에 못 받으면 캐시.
 *     예전에는 전부 캐시 우선이었는데, 그러면 버그 있는 버전이 한번 저장된 기기는
 *     계속 그 버전을 쓰게 된다. 실제로 한 기기가 고쳐진 뒤에도 옛 화면에 갇혔다.
 *     코드는 늘 최신이어야 하고, 오프라인일 때만 캐시로 떨어지면 된다.
 *
 *   자산(음성 wav·아이콘) — 캐시 우선. 내용이 바뀌지 않고 용량이 크다.
 *
 * 배포할 때 CACHE 뒤의 버전과 js/version.js 를 함께 올린다.
 */
var CACHE = 'dsm-v5';
var NET_TIMEOUT = 2500;

var SYLLABLES = ['1', '2', '3', '4', '5', '6', '7', '8', 'cha', 'a', 'and', 'slow', 'quick'];
var VOICE_PACKS = ['ko-heami', 'en-zira'];

var ASSETS = [
  './',
  'index.html',
  'diag.html',
  'styles.css',
  'manifest.webmanifest',
  'js/version.js',
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

function isCode(url) {
  return /\.(html|css|js|webmanifest)$/i.test(url.pathname) || url.pathname.match(/\/$/);
}

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

/* 페이지에서 보낸 강제 초기화 요청 */
self.addEventListener('message', function (e) {
  if (e.data === 'dsm-reset') {
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return caches.delete(k); }));
    }).then(function () {
      if (e.source && e.source.postMessage) e.source.postMessage('dsm-reset-done');
    });
  }
});

function fromNetwork(req) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; reject(new Error('timeout')); } }, NET_TIMEOUT);
    fetch(req).then(function (res) {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve(res);
    }, function (err) {
      if (done) return;
      done = true; clearTimeout(timer);
      reject(err);
    });
  });
}

function put(req, res) {
  if (res && res.status === 200 && res.type === 'basic') {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(req, copy); });
  }
  return res;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  if (isCode(url)) {
    // 코드: 네트워크 우선 (오프라인이면 캐시)
    e.respondWith(
      fromNetwork(req).then(function (res) { return put(req, res); })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            if (hit) return hit;
            if (req.mode === 'navigate') return caches.match('index.html');
            return new Response('', { status: 504 });
          });
        })
    );
    return;
  }

  // 자산: 캐시 우선
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) { return put(req, res); })
        .catch(function () { return new Response('', { status: 504 }); });
    })
  );
});
