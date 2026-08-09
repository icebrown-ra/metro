/* 연습 기록
 *
 * 실제로 소리가 나던 시간만 센다 (일시정지·정지 중에는 안 센다).
 * 전부 이 폰의 localStorage 에만 저장되고 어디로도 전송되지 않는다.
 *
 * 저장 형태  { "2026-08-09": { t: 총초, d: { rumba: 초, waltz: 초 } } }
 */
window.DSM = window.DSM || {};

DSM.Stats = (function () {
  'use strict';

  var KEY = 'dsm.stats';
  var GOAL_KEY = 'dsm.goal';
  var data = null;

  function load() {
    if (data) return data;
    try { data = JSON.parse(localStorage.getItem(KEY)) || {}; }
    catch (e) { data = {}; }
    return data;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* 용량 초과 */ }
  }

  function dayKey(d) {
    d = d || new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function add(danceId, seconds) {
    if (!(seconds > 0)) return;
    load();
    var k = dayKey();
    if (!data[k]) data[k] = { t: 0, d: {} };
    data[k].t += seconds;
    if (danceId) data[k].d[danceId] = (data[k].d[danceId] || 0) + seconds;
    save();
  }

  function today() {
    load();
    var e = data[dayKey()];
    return e ? e.t : 0;
  }

  /* 최근 n일 (오늘 포함), 오래된 날짜부터 */
  function recent(n) {
    load();
    var out = [];
    var now = new Date();
    for (var i = n - 1; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      var k = dayKey(d);
      var e = data[k];
      out.push({ date: k, day: d, total: e ? e.t : 0, byDance: e ? e.d : {} });
    }
    return out;
  }

  function totalsByDance(days) {
    var rows = recent(days || 3650);
    var acc = {};
    rows.forEach(function (r) {
      Object.keys(r.byDance).forEach(function (id) {
        acc[id] = (acc[id] || 0) + r.byDance[id];
      });
    });
    return acc;
  }

  function grandTotal() {
    load();
    var s = 0;
    Object.keys(data).forEach(function (k) { s += data[k].t; });
    return s;
  }

  /* 연속 연습 일수. 오늘 아직 안 했으면 어제까지로 센다. */
  function streak(minSeconds) {
    load();
    var min = minSeconds || 60;
    var now = new Date();
    var n = 0;
    for (var i = 0; i < 3650; i++) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      var e = data[dayKey(d)];
      var ok = e && e.t >= min;
      if (ok) { n++; continue; }
      if (i === 0) continue;   // 오늘은 아직 안 했을 수 있으니 건너뛴다
      break;
    }
    return n;
  }

  function goal() {
    var v = parseInt(localStorage.getItem(GOAL_KEY), 10);
    return isFinite(v) && v > 0 ? v : 30 * 60;   // 기본 하루 30분
  }

  function setGoal(seconds) {
    localStorage.setItem(GOAL_KEY, String(Math.max(60, seconds)));
  }

  function activeDays() {
    load();
    var n = 0;
    Object.keys(data).forEach(function (k) { if (data[k].t >= 60) n++; });
    return n;
  }

  function exportJson() {
    load();
    return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), stats: data }, null, 2);
  }

  function importJson(text) {
    var parsed = JSON.parse(text);
    var incoming = parsed.stats || parsed;
    load();
    Object.keys(incoming).forEach(function (k) {
      var src = incoming[k];
      if (!src || typeof src.t !== 'number') return;
      if (!data[k]) data[k] = { t: 0, d: {} };
      // 같은 날짜는 더 큰 값을 남긴다 (중복 병합으로 시간이 부풀지 않게)
      data[k].t = Math.max(data[k].t, src.t);
      Object.keys(src.d || {}).forEach(function (id) {
        data[k].d[id] = Math.max(data[k].d[id] || 0, src.d[id]);
      });
    });
    save();
  }

  function reset() {
    data = {};
    save();
  }

  /* 표시용: 1시간 12분 / 12분 / 40초 */
  function fmt(seconds) {
    var s = Math.round(seconds || 0);
    if (s < 60) return s + '초';
    var m = Math.round(s / 60);
    if (m < 60) return m + '분';
    var h = Math.floor(m / 60);
    var rm = m % 60;
    return rm ? h + '시간 ' + rm + '분' : h + '시간';
  }

  return {
    add: add,
    today: today,
    recent: recent,
    totalsByDance: totalsByDance,
    grandTotal: grandTotal,
    activeDays: activeDays,
    streak: streak,
    goal: goal,
    setGoal: setGoal,
    exportJson: exportJson,
    importJson: importJson,
    reset: reset,
    fmt: fmt,
    dayKey: dayKey
  };
})();
