/* 음원 위에 박자세기 얹기
 *
 * 곡을 불러와 박에 맞춰 탭하면 곡의 템포와 첫 다운비트 위치를 계산한다.
 * 그 값으로 메트로놈 그리드를 곡에 잠그면, 음원과 카운트가 같은 AudioContext
 * 시계에 예약되므로 곡이 끝날 때까지 어긋나지 않는다.
 *
 * 파일은 어디에도 올라가지 않는다 — 폰 안에서만 디코딩하고 IndexedDB에 보관한다.
 */
window.DSM = window.DSM || {};

DSM.Music = (function () {
  'use strict';

  var ctx = null;
  var current = null;   // { id, name, danceId, buffer, data, align:{bpm,offset}, startBar }
  var taps = [];

  function init(audioCtx) { ctx = audioCtx; }

  /* ---------------- 파일 읽기 ---------------- */

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsArrayBuffer(file);
    });
  }

  function loadFile(file) {
    return readFile(file).then(function (data) {
      return DSM.Voices.decode(data.slice(0)).then(function (buffer) {
        current = {
          id: 'trk-' + Date.now(),
          name: file.name.replace(/\.[^.]+$/, ''),
          danceId: null,
          buffer: buffer,
          data: data,
          align: null,
          startBar: 0
        };
        taps = [];
        return current;
      });
    });
  }

  /* ---------------- 탭 정렬 ---------------- */

  function tapReset() { taps = []; }

  function tapCount() { return taps.length; }

  /* 각 탭 시점의 "곡 안 위치(초)"를 넘긴다 */
  function tap(musicPos) {
    taps.push(musicPos);
    return analyze();
  }

  function median(arr) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /* 최소제곱으로 박 간격과 첫 박 위치를 동시에 구한다.
   * 탭 하나를 빠뜨려도 되도록, 간격이 중앙값의 배수인지 보고 박 번호를 매긴다. */
  function analyze() {
    if (taps.length < 4) return null;

    var dts = [];
    for (var i = 1; i < taps.length; i++) dts.push(taps[i] - taps[i - 1]);
    var med = median(dts);
    if (!(med > 0.05)) return null;

    var idx = [0];
    for (var j = 1; j < taps.length; j++) {
      var k = Math.round((taps[j] - taps[j - 1]) / med);
      if (k < 1) k = 1;
      idx.push(idx[j - 1] + k);
    }

    var n = taps.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var t = 0; t < n; t++) {
      sx += idx[t]; sy += taps[t];
      sxx += idx[t] * idx[t]; sxy += idx[t] * taps[t];
    }
    var denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    var slope = (n * sxy - sx * sy) / denom;      // 한 박의 길이(초)
    var intercept = (sy - slope * sx) / n;        // 첫 박(다운비트)의 위치
    if (!(slope > 0.05)) return null;

    // 탭이 얼마나 고른지 — 화면에 신뢰도로 보여준다
    var err = 0;
    for (var u = 0; u < n; u++) {
      var d = taps[u] - (intercept + slope * idx[u]);
      err += d * d;
    }
    var rms = Math.sqrt(err / n);

    var offset = intercept;
    while (offset < 0) offset += slope;

    return { bpm: 60 / slope, offset: offset, rmsMs: rms * 1000, taps: n };
  }

  function setAlign(align) {
    if (!current) return;
    current.align = { bpm: align.bpm, offset: align.offset };
  }

  function nudgeBpm(delta) {
    if (!current || !current.align) return null;
    current.align.bpm = Math.max(20, Math.min(400, current.align.bpm + delta));
    return current.align;
  }

  function nudgeOffset(deltaSec) {
    if (!current || !current.align) return null;
    var o = current.align.offset + deltaSec;
    if (o < 0) o = 0;
    if (current.buffer && o > current.buffer.duration) o = current.buffer.duration;
    current.align.offset = o;
    return current.align;
  }

  /* 절반/두 배로 잘못 잡히는 경우가 흔해서 버튼으로 바로 고칠 수 있게 한다 */
  function scaleBpm(factor) {
    if (!current || !current.align) return null;
    current.align.bpm = Math.max(20, Math.min(400, current.align.bpm * factor));
    return current.align;
  }

  function get() { return current; }

  function clear() { current = null; taps = []; }

  /* ---------------- 저장 ---------------- */

  function save() {
    if (!current || !current.align) return Promise.resolve(null);
    var row = {
      id: current.id,
      name: current.name,
      danceId: current.danceId,
      bpm: current.align.bpm,
      offset: current.align.offset,
      startBar: current.startBar || 0,
      addedAt: Date.now(),
      data: current.data
    };
    return DSM.Voices.idb.put('tracks', row).then(function () { return row; });
  }

  function listSaved() {
    return DSM.Voices.idb.all('tracks').then(function (rows) {
      return rows.sort(function (a, b) { return b.addedAt - a.addedAt; })
        .map(function (r) {
          return { id: r.id, name: r.name, danceId: r.danceId, bpm: r.bpm, addedAt: r.addedAt };
        });
    });
  }

  function open(id) {
    return DSM.Voices.idb.all('tracks').then(function (rows) {
      var row = null;
      for (var i = 0; i < rows.length; i++) if (rows[i].id === id) row = rows[i];
      if (!row) return null;
      return DSM.Voices.decode(row.data.slice(0)).then(function (buffer) {
        current = {
          id: row.id, name: row.name, danceId: row.danceId,
          buffer: buffer, data: row.data,
          align: { bpm: row.bpm, offset: row.offset },
          startBar: row.startBar || 0
        };
        taps = [];
        return current;
      });
    });
  }

  function remove(id) { return DSM.Voices.idb.del('tracks', id); }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  return {
    init: init,
    loadFile: loadFile,
    tap: tap,
    tapReset: tapReset,
    tapCount: tapCount,
    analyze: analyze,
    setAlign: setAlign,
    nudgeBpm: nudgeBpm,
    nudgeOffset: nudgeOffset,
    scaleBpm: scaleBpm,
    get: get,
    clear: clear,
    save: save,
    listSaved: listSaved,
    open: open,
    remove: remove,
    fmtTime: fmtTime
  };
})();
