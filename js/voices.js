/* 목소리 팩 시스템
 *
 * 핵심 아이디어: 음절을 "의미 기반 고정 키"로 다루고, 팩은 그 키들의 집합일 뿐이다.
 * 새 목소리를 추가하려면 audio/voices/<id>/ 폴더에 아래 13개 파일을 넣고
 * BUILTIN 배열에 한 줄 추가하면 끝이다.
 *
 *   1.wav 2.wav 3.wav 4.wav 5.wav 6.wav 7.wav 8.wav
 *   cha.wav a.wav and.wav slow.wav quick.wav
 *
 * 일부만 있는 팩도 된다 — 없는 음절은 기본 팩에서 자동으로 채운다.
 */
window.DSM = window.DSM || {};

DSM.Voices = (function () {
  'use strict';

  var SYLLABLES = ['1', '2', '3', '4', '5', '6', '7', '8', 'cha', 'a', 'and', 'slow', 'quick'];

  var LABEL_KO = {
    '1': '원', '2': '투', '3': '쓰리', '4': '포', '5': '파이브',
    '6': '식스', '7': '세븐', '8': '에잇',
    cha: '차', a: '아', and: '앤', slow: '슬로우', quick: '퀵'
  };

  var BUILTIN = [
    { id: 'ko-heami', name: '한국어 (기본)', lang: 'ko', base: 'audio/voices/ko-heami/' },
    { id: 'en-zira', name: 'English', lang: 'en', base: 'audio/voices/en-zira/' }
  ];

  var FALLBACK_ID = 'ko-heami';

  var ctx = null;
  var loaded = {};        // packId -> { key: AudioBuffer }
  var userPacks = [];     // IndexedDB 에서 읽어온 사용자 팩 메타
  var activeId = null;
  var activeMap = {};
  var fallbackMap = {};

  /* ---------------- IndexedDB ---------------- */

  var DB_NAME = 'dsm';
  var DB_VER = 1;
  var dbp = null;

  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains('voicepacks')) d.createObjectStore('voicepacks', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('tracks')) d.createObjectStore('tracks', { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  function idbAll(store) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(store, 'readonly');
        var req = tx.objectStore(store).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbPut(store, value) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(store, 'readwrite');
        tx.objectStore(store).put(value);
        tx.oncomplete = function () { resolve(value); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbDelete(store, id) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(store, 'readwrite');
        tx.objectStore(store).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /* init() 을 거치지 않고 decode/trim 을 쓰는 호출자(음원 모듈·진단 페이지)가 있어서
   * 컨텍스트를 지연 조회한다. 이게 없으면 ctx 가 null 인 채로 터진다. */
  function actx() {
    if (!ctx && window.DSM && DSM.Audio && DSM.Audio.context) ctx = DSM.Audio.context() || null;
    if (!ctx && DSM.Audio && DSM.Audio.init) ctx = DSM.Audio.init();
    return ctx;
  }

  /* ---------------- 오디오 유틸 ---------------- */

  /* 앞뒤 무음을 잘라낸다.
   * 이게 없으면 음절이 박보다 늦게 들린다 — 음성 카운트에서 가장 중요한 처리. */
  function trim(buffer, thresholdDb, padMs) {
    var th = Math.pow(10, (thresholdDb === undefined ? -42 : thresholdDb) / 20);
    var pad = Math.floor((padMs === undefined ? 6 : padMs) / 1000 * buffer.sampleRate);
    var n = buffer.length, ch = buffer.numberOfChannels;
    var data = [];
    for (var c = 0; c < ch; c++) data.push(buffer.getChannelData(c));

    function peakAt(i) {
      var p = 0;
      for (var c2 = 0; c2 < ch; c2++) { var v = Math.abs(data[c2][i]); if (v > p) p = v; }
      return p;
    }

    var start = 0, end = n - 1;
    while (start < n && peakAt(start) < th) start++;
    while (end > start && peakAt(end) < th) end--;
    if (start >= n) return buffer; // 전부 무음이면 그대로 둔다

    start = Math.max(0, start - pad);
    end = Math.min(n - 1, end + pad);
    var len = end - start + 1;

    var out = actx().createBuffer(ch, len, buffer.sampleRate);
    for (var c3 = 0; c3 < ch; c3++) {
      out.getChannelData(c3).set(data[c3].subarray(start, end + 1));
    }
    return out;
  }

  /* 피크를 -3dB 로 맞춘다 — 음절마다 볼륨이 들쭉날쭉하지 않게 */
  function normalize(buffer, targetDb) {
    var target = Math.pow(10, (targetDb === undefined ? -3 : targetDb) / 20);
    var peak = 0, ch = buffer.numberOfChannels;
    for (var c = 0; c < ch; c++) {
      var d = buffer.getChannelData(c);
      for (var i = 0; i < d.length; i++) { var v = Math.abs(d[i]); if (v > peak) peak = v; }
    }
    if (peak === 0) return buffer;
    var gain = target / peak;
    for (var c2 = 0; c2 < ch; c2++) {
      var d2 = buffer.getChannelData(c2);
      for (var j = 0; j < d2.length; j++) d2[j] *= gain;
    }
    return buffer;
  }

  /* 체감 시작점(P-center 근사) — 자기 피크의 25% 에 처음 도달하는 시각.
   *
   * "쓰리"의 ㅆ, "투"의 기음처럼 앞이 무딘 음절은 파일 시작을 박에 맞춰도
   * 귀에는 늦게 들린다(측정해보니 최대 73ms). 그래서 재생할 때 이만큼
   * 앞당겨 예약해 체감 시작점이 박에 오게 한다. 파일을 더 자르면 발음이
   * 뭉개지므로 자르지 않고 예약 시각으로 보정한다. */
  var leadCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;

  function leadOf(buffer) {
    if (!buffer) return 0;
    if (leadCache && leadCache.has(buffer)) return leadCache.get(buffer);
    var d = buffer.getChannelData(0);
    var pk = 0, i;
    for (i = 0; i < d.length; i++) { var v = Math.abs(d[i]); if (v > pk) pk = v; }
    var th = pk * 0.25;
    for (i = 0; i < d.length && Math.abs(d[i]) < th; i++) { }
    var lead = Math.min(0.12, i / buffer.sampleRate);   // 병적인 경우 방지
    if (leadCache) leadCache.set(buffer, lead);
    return lead;
  }

  /* AudioBuffer -> 16bit WAV ArrayBuffer (IndexedDB 저장 · 도구 내보내기용) */
  function encodeWav(buffer) {
    var ch = buffer.numberOfChannels, len = buffer.length, rate = buffer.sampleRate;
    var bytes = len * ch * 2;
    var ab = new ArrayBuffer(44 + bytes);
    var v = new DataView(ab);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, ch, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, bytes, true);
    var o = 44;
    var chans = [];
    for (var c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
    for (var i = 0; i < len; i++) {
      for (var c2 = 0; c2 < ch; c2++) {
        var s = Math.max(-1, Math.min(1, chans[c2][i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return ab;
  }

  function decode(arrayBuffer) {
    return new Promise(function (resolve, reject) {
      var c = actx();
      if (!c) { reject(new Error('AudioContext 없음')); return; }
      // Safari 는 Promise 형태를 늦게 지원했으므로 콜백 형태도 함께 받는다
      var p = c.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  /* ---------------- 팩 로딩 ---------------- */

  function fetchBuffer(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.arrayBuffer();
    }).then(function (ab) {
      return decode(ab.slice(0));
    });
  }

  function loadBuiltin(pack) {
    if (loaded[pack.id]) return Promise.resolve(loaded[pack.id]);
    var map = {};
    var jobs = SYLLABLES.map(function (key) {
      return fetchBuffer(pack.base + key + '.wav')
        .then(function (buf) { map[key] = buf; })
        .catch(function () { /* 없는 음절은 fallback 이 채운다 */ });
    });
    return Promise.all(jobs).then(function () {
      loaded[pack.id] = map;
      return map;
    });
  }

  function loadUser(pack) {
    if (loaded[pack.id]) return Promise.resolve(loaded[pack.id]);
    return idbAll('voicepacks').then(function (rows) {
      var row = null;
      for (var i = 0; i < rows.length; i++) if (rows[i].id === pack.id) row = rows[i];
      if (!row) return {};
      var map = {};
      var keys = Object.keys(row.files || {});
      var jobs = keys.map(function (key) {
        return decode(row.files[key].slice(0))
          .then(function (buf) { map[key] = buf; })
          .catch(function () { });
      });
      return Promise.all(jobs).then(function () {
        loaded[pack.id] = map;
        return map;
      });
    });
  }

  function findPack(id) {
    for (var i = 0; i < BUILTIN.length; i++) if (BUILTIN[i].id === id) return BUILTIN[i];
    for (var j = 0; j < userPacks.length; j++) if (userPacks[j].id === id) return userPacks[j];
    return null;
  }

  function loadPack(id) {
    var pack = findPack(id);
    if (!pack) return Promise.resolve({});
    return pack.source === 'user' ? loadUser(pack) : loadBuiltin(pack);
  }

  /* ---------------- 공개 API ---------------- */

  function init(audioCtx) {
    ctx = audioCtx;
    return idbAll('voicepacks').then(function (rows) {
      userPacks = rows.map(function (r) {
        return { id: r.id, name: r.name, lang: r.lang || 'ko', source: 'user' };
      });
    }).catch(function () { userPacks = []; });
  }

  function list() {
    return BUILTIN.map(function (p) {
      return { id: p.id, name: p.name, lang: p.lang, source: 'builtin' };
    }).concat(userPacks);
  }

  function select(id) {
    if (!ctx) return Promise.resolve();
    var jobs = [loadPack(id)];
    if (id !== FALLBACK_ID) jobs.push(loadPack(FALLBACK_ID));
    return Promise.all(jobs).then(function (maps) {
      activeId = id;
      activeMap = maps[0] || {};
      fallbackMap = (id === FALLBACK_ID) ? activeMap : (maps[1] || {});
    });
  }

  /* 스케줄러가 동기적으로 호출한다 — 미리 로드된 맵에서만 찾는다 */
  function getBuffer(key) {
    return activeMap[key] || fallbackMap[key] || null;
  }

  function coverage(id) {
    var map = loaded[id];
    if (!map) return 0;
    var n = 0;
    SYLLABLES.forEach(function (k) { if (map[k]) n++; });
    return n;
  }

  /* 녹음/임포트한 오디오를 트림·노멀라이즈해서 사용자 팩에 저장 */
  function saveSyllable(packId, packName, key, arrayBuffer) {
    return decode(arrayBuffer.slice(0)).then(function (buf) {
      var clean = normalize(trim(buf));
      var wav = encodeWav(clean);
      return idbAll('voicepacks').then(function (rows) {
        var row = null;
        for (var i = 0; i < rows.length; i++) if (rows[i].id === packId) row = rows[i];
        if (!row) row = { id: packId, name: packName || packId, lang: 'ko', files: {} };
        row.files[key] = wav;
        if (packName) row.name = packName;
        return idbPut('voicepacks', row);
      }).then(function () {
        // 캐시 무효화 후 즉시 반영
        delete loaded[packId];
        if (!findPack(packId)) userPacks.push({ id: packId, name: packName || packId, lang: 'ko', source: 'user' });
        if (activeId === packId) return select(packId);
      });
    });
  }

  function deletePack(id) {
    return idbDelete('voicepacks', id).then(function () {
      delete loaded[id];
      userPacks = userPacks.filter(function (p) { return p.id !== id; });
      if (activeId === id) return select(FALLBACK_ID);
    });
  }

  return {
    SYLLABLES: SYLLABLES,
    LABEL_KO: LABEL_KO,
    FALLBACK_ID: FALLBACK_ID,
    init: init,
    list: list,
    select: select,
    activeId: function () { return activeId; },
    getBuffer: getBuffer,
    coverage: coverage,
    saveSyllable: saveSyllable,
    deletePack: deletePack,
    leadOf: leadOf,
    getLead: function (key) { return leadOf(getBuffer(key)); },
    // 도구·음원 모듈이 재사용
    trim: trim,
    normalize: normalize,
    encodeWav: encodeWav,
    decode: decode,
    idb: { all: idbAll, put: idbPut, del: idbDelete }
  };
})();
