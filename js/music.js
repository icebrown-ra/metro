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

  /* ---------------- 정렬 기억 ----------------
   *
   * 곡 파일 자체는 폰에만 두지만, 곡 이름별 정렬값(템포·다운비트)은 가볍게
   * 기억해 둔다. 같은 곡을 다시 열거나 다른 기기에서 열었을 때 탭을 다시
   * 하지 않아도 되게 하려는 것. 계정 동기화가 켜져 있으면 이 값이 오간다. */
  var MEM_KEY = 'dsm.alignMemory';

  function memory() {
    try { return JSON.parse(localStorage.getItem(MEM_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function saveMemory(m) {
    try { localStorage.setItem(MEM_KEY, JSON.stringify(m)); } catch (e) { }
  }

  function nameKey(name) {
    return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function remember(name, align, startBar, danceId) {
    if (!align) return;
    var m = memory();
    m[nameKey(name)] = {
      name: name, bpm: align.bpm, offset: align.offset,
      startBar: startBar || 0, danceId: danceId || null, at: Date.now()
    };
    saveMemory(m);
  }

  function recall(name) {
    return memory()[nameKey(name)] || null;
  }

  function listMemory() {
    var m = memory();
    return Object.keys(m).map(function (k) {
      var e = m[k];
      return {
        id: k, name: e.name, danceId: e.danceId,
        bpm: e.bpm, offset: e.offset, startBar: e.startBar
      };
    });
  }

  function mergeMemory(rows) {
    var m = memory(), changed = false;
    (rows || []).forEach(function (r) {
      var k = nameKey(r.name || r.id);
      if (!m[k]) {
        m[k] = {
          name: r.name, bpm: r.bpm, offset: r.offset_sec,
          startBar: r.start_bar || 0, danceId: r.dance_id || null, at: 0
        };
        changed = true;
      }
    });
    if (changed) saveMemory(m);
    return changed;
  }

  function loadFile(file) {
    return readFile(file).then(function (data) {
      return DSM.Voices.decode(data.slice(0)).then(function (buffer) {
        var name = file.name.replace(/\.[^.]+$/, '');
        var known = recall(name);
        current = {
          id: 'trk-' + Date.now(),
          name: name,
          danceId: known ? known.danceId : null,
          buffer: buffer,
          data: data,
          align: known ? { bpm: known.bpm, offset: known.offset } : null,
          startBar: known ? (known.startBar || 0) : 0,
          recalled: !!known
        };
        taps = [];
        return current;
      });
    });
  }

  /* ---------------- 자동 템포 인식 ----------------
   *
   * 곡에서 소리가 세지는 순간(온셋)을 뽑아 그 간격이 얼마마다 반복되는지 본다.
   * 일반 BPM 인식기와 다른 점은, 어느 종목인지 알고 있다는 것이다.
   * 템포가 절반이나 두 배로 잡히는 고질적인 오류를 종목의 공식 템포로 걸러낸다.
   */

  /* 프레임마다 "소리가 얼마나 세졌는지" — 박이 있는 자리에서 값이 커진다 */
  function onsetEnvelope(buffer) {
    var sr = buffer.sampleRate;
    var hop = Math.max(1, Math.round(sr * 0.005));      // 5ms
    var n = Math.floor(buffer.length / hop) - 1;
    if (n < 100) return null;

    var a = buffer.getChannelData(0);
    var b = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    var env = new Float32Array(n);
    var prev = 0;

    for (var i = 0; i < n; i++) {
      var s = i * hop, sum = 0;
      for (var j = 0; j < hop; j++) {
        var v = b ? (a[s + j] + b[s + j]) * 0.5 : a[s + j];
        sum += v * v;
      }
      var rms = Math.sqrt(sum / hop);
      env[i] = rms > prev ? (rms - prev) : 0;           // 커진 쪽만 본다
      prev = rms;
    }

    // 곡의 강약 변화에 휘둘리지 않게 이동평균으로 정규화.
    // 창이 한 박보다 짧으면 박 자체가 평균에 먹혀 주기성이 사라진다 —
    // 가장 빠른 종목(퀵스텝 204BPM, 한 박 0.29초)보다 넉넉히 길어야 한다.
    var rateHz = sr / hop;
    var w = Math.max(Math.round(2 * rateHz), 200);      // 2초
    var out = new Float32Array(n);
    var run = 0;
    for (var k = 0; k < n; k++) {
      run += env[k];
      if (k >= w) run -= env[k - w];
      var mean = run / Math.min(k + 1, w);
      out[k] = mean > 1e-9 ? env[k] / mean : 0;
    }

    /* 온셋을 살짝 뭉갠다.
     * 한 박이 프레임 수의 정수배가 아니면(퀵스텝은 58.69프레임) 뾰족한 스파이크끼리는
     * 몇 박만 지나도 어긋나 상관이 0이 된다. 25ms 정도로 펴 두면 그 밀림을 견딘다. */
    var K = Math.max(2, Math.round(0.025 * rateHz));
    var sm = new Float32Array(n);
    var acc = 0;
    for (var i2 = 0; i2 < n + K; i2++) {
      if (i2 < n) acc += out[i2];
      if (i2 - (2 * K + 1) >= 0) acc -= out[i2 - (2 * K + 1)];
      var c = i2 - K;
      if (c >= 0 && c < n) sm[c] = acc / (2 * K + 1);
    }

    return { env: sm, raw: out, rate: rateHz };
  }

  /* 온셋의 정점을 소수 프레임까지 (포물선 보간).
   * 프레임 단위로만 보면 주기가 프레임의 정수배로 끌려간다. */
  function onsetPeaks(raw, rate) {
    var mean = 0, i;
    for (i = 0; i < raw.length; i++) mean += raw[i];
    mean /= raw.length || 1;
    var th = mean * 2;
    var peaks = [];
    for (i = 1; i < raw.length - 1; i++) {
      var v = raw[i];
      if (v <= th || v < raw[i - 1] || v < raw[i + 1]) continue;
      var den = raw[i - 1] - 2 * v + raw[i + 1];
      var d = den !== 0 ? 0.5 * (raw[i - 1] - raw[i + 1]) / den : 0;
      if (d > 1 || d < -1) d = 0;
      peaks.push({ t: (i + d) / rate, v: v });
    }
    return peaks;
  }

  /* 대략의 주기·위상에서 출발해, 격자에 붙는 온셋만 골라 최소제곱으로 다시 맞춘다.
   * 탭 정렬에서 쓰는 것과 같은 방법을 사람 손가락 대신 온셋에 적용하는 것. */
  function fitGrid(peaks, period, phase) {
    var P = period, t0 = phase, used = 0;
    for (var it = 0; it < 5; it++) {
      var sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
      for (var i = 0; i < peaks.length; i++) {
        var k = Math.round((peaks[i].t - t0) / P);
        if (Math.abs(peaks[i].t - (t0 + k * P)) > P * 0.15) continue;   // 격자에서 먼 것은 뺀다
        var w = peaks[i].v;
        sw += w; sx += w * k; sy += w * peaks[i].t;
        sxx += w * k * k; sxy += w * k * peaks[i].t;
        cnt++;
      }
      if (cnt < 8) break;
      var den = sw * sxx - sx * sx;
      if (!den) break;
      var slope = (sw * sxy - sx * sy) / den;
      var inter = (sy - slope * sx) / sw;
      if (!(slope > 0.05)) break;
      P = slope; t0 = inter; used = cnt;
    }
    while (t0 >= P) t0 -= P;
    while (t0 < 0) t0 += P;
    return { period: P, phase: t0, used: used };
  }

  /* 주기 P(프레임, 소수 허용)로 얼마나 잘 반복되는지.
   * 정수 lag 만 보면 위의 밀림 문제로 엉뚱한 배수에 잠긴다. */
  function periodScore(env, P) {
    var n = env.length - Math.ceil(P) - 1;
    if (n < 50) return 0;
    var sum = 0;
    for (var i = 0; i < n; i++) {
      var x = i + P;
      var f = x | 0, fr = x - f;
      sum += env[i] * (env[f] * (1 - fr) + env[f + 1] * fr);
    }
    return sum / n;
  }

  /* 주기를 알 때, 그 주기 안 어디에 박이 있는지 */
  function foldPhase(env, rate, periodSec, bins) {
    var P = periodSec * rate;
    var acc = new Float32Array(bins);
    for (var i = 0; i < env.length; i++) {
      var ph = i - Math.floor(i / P) * P;
      acc[Math.min(bins - 1, Math.floor(ph / P * bins))] += env[i];
    }
    var best = 0;
    for (var k = 1; k < bins; k++) if (acc[k] > acc[best]) best = k;
    return { bin: best, acc: acc };
  }

  function detectTempo(buffer, dance) {
    var e = onsetEnvelope(buffer);
    if (!e) return null;
    var env = e.env, rate = e.rate;

    // 60~220 BPM 을 0.25프레임 간격으로 훑어 가장 잘 맞는 주기를 찾는다
    var minP = 60 / 220 * rate;
    var maxP = 60 / 60 * rate;
    var bestP = minP, bestScore = -1, total = 0, cnt = 0;
    for (var P = minP; P <= maxP; P += 0.25) {
      var sc = periodScore(env, P);
      total += sc; cnt++;
      if (sc > bestScore) { bestScore = sc; bestP = P; }
    }
    if (bestScore <= 0) return null;
    var confidence = bestScore / (total / cnt);

    /* 정수배 오류 보정.
     * 그냥 "공식 템포에 가장 가까운 배수"를 고르면, 느리게 만든 연습용 음원
     * (룸바 73BPM 같은)을 절반으로 잘못 잡힌 것으로 오인해 146으로 올려버린다.
     * 그래서 측정값 자체를 우선하고, 배수로 바꾸려면 그만큼 더 가까워야 하게 벌점을 준다. */
    var raw = 60 / (bestP / rate);
    var target = dance ? dance.bpm.def : raw;
    /* 어떤 배수가 실제로 나올 수 있는지는 박자에 달렸다.
     * 3박자는 한 마디가 세 박이라 x3 이 진짜 나오고(비엔나 왈츠는 마디가 59BPM 이라
     * 탐색 하한 바로 아래에 걸린다), 2·4박자는 2의 거듭제곱만 나온다.
     * 박자와 무관하게 x3 을 열어 두면 4박자 종목이 엉뚱한 값으로 끌려간다. */
    var per3 = dance && dance.beatsPerBar === 3;
    var cands = per3
      ? [{ v: raw, pen: 0 },
         { v: raw * 2, pen: 0.25 }, { v: raw / 2, pen: 0.25 },
         { v: raw * 3, pen: 0.30 }, { v: raw / 3, pen: 0.30 }]
      : [{ v: raw, pen: 0 },
         { v: raw * 2, pen: 0.25 }, { v: raw / 2, pen: 0.25 },
         { v: raw * 4, pen: 0.50 }, { v: raw / 4, pen: 0.50 }];
    var bpm = raw, bestDist = Infinity;
    cands.forEach(function (c) {
      if (c.v < 40 || c.v > 320) return;
      var d = Math.abs(Math.log(c.v / target)) + c.pen;
      if (d < bestDist) { bestDist = d; bpm = c.v; }
    });

    /* 고른 배수 근처를 다시 훑어 정확한 값을 잡는다.
     * 여기서 대충 끝내면 안 된다 — 템포가 0.5%만 어긋나도 24초 뒤엔 위상이
     * 60ms 넘게 밀려서 다운비트 위치가 통째로 틀어진다. 두 단계로 좁힌다. */
    function refine(center, halfRange, step) {
      var bp = center, bs = -1;
      for (var p = center - halfRange; p <= center + halfRange; p += step) {
        if (p < 8) continue;
        var s2 = periodScore(env, p);
        if (s2 > bs) { bs = s2; bp = p; }
      }
      return bp;
    }
    var around = 60 / bpm * rate;
    var refP = refine(around, around * 0.04, 0.05);
    refP = refine(refP, 0.06, 0.004);
    bpm = 60 / (refP / rate);

    // 대략의 위상을 잡고, 온셋 정점으로 주기·위상을 정밀하게 다시 맞춘다
    var beatSec = 60 / bpm;
    var ph = foldPhase(env, rate, beatSec, 96);
    var offset = (ph.bin + 0.5) / 96 * beatSec;

    var fit = fitGrid(onsetPeaks(e.raw, rate), beatSec, offset);
    if (fit.used >= 8) {
      beatSec = fit.period;
      bpm = 60 / beatSec;
      offset = fit.phase;
    }

    var per = dance ? dance.beatsPerBar : 4;
    var barAcc = new Float32Array(per);
    var beats = Math.floor((buffer.duration - offset) / beatSec);
    for (var k = 0; k < beats; k++) {
      var idx = Math.round((offset + k * beatSec) * rate);
      var s = 0;
      for (var j = -2; j <= 2; j++) {
        var m = idx + j;
        if (m >= 0 && m < env.length) s += env[m];
      }
      barAcc[k % per] += s;
    }
    var down = 0;
    for (var q = 1; q < per; q++) if (barAcc[q] > barAcc[down]) down = q;
    offset += down * beatSec;
    while (offset >= beatSec * per) offset -= beatSec * per;

    return { bpm: bpm, offset: offset, confidence: confidence, auto: true };
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
    fmtTime: fmtTime,
    detectTempo: detectTempo,
    remember: remember,
    recall: recall,
    listMemory: listMemory,
    mergeMemory: mergeMemory
  };
})();
