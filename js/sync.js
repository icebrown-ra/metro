/* 계정 동기화 (Supabase)
 *
 * 이 파일이 없거나 설정이 비어 있어도 앱은 그대로 동작한다.
 * 동기화는 어디까지나 덤이고, 메트로놈은 오프라인에서 완결되어야 한다.
 *
 * 올라가는 것   연습 기록(조각 단위) · 설정 · 음원 정렬 정보
 * 안 올라가는 것 음원 파일, 녹음한 목소리 (용량이 크고 저작권 문제도 있다)
 *
 * supabase-js 는 206KB 라 첫 화면을 붙잡지 않도록 필요할 때만 불러온다.
 */
window.DSM = window.DSM || {};

DSM.Sync = (function () {
  'use strict';

  var VENDOR = 'js/vendor/supabase.js';
  var LAST_KEY = 'dsm.lastSync';
  var BACKFILL_DONE = 'dsm.backfillDone';

  var client = null;
  var loading = null;
  var user = null;
  var listeners = [];
  var busy = false;

  function cfg() {
    return (window.DSM && DSM.SupabaseConfig) || null;
  }

  function configured() {
    var c = cfg();
    return !!(c && c.url && c.anonKey && c.url.indexOf('http') === 0);
  }

  function emit(state, msg) {
    listeners.forEach(function (fn) {
      try { fn(state, msg); } catch (e) { }
    });
  }

  function onChange(fn) { listeners.push(fn); }

  /* ---------------- 지연 로딩 ---------------- */

  function loadVendor() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = VENDOR;
      s.async = true;
      s.onload = function () {
        if (window.supabase && window.supabase.createClient) resolve();
        else reject(new Error('supabase-js 로드 실패'));
      };
      s.onerror = function () { reject(new Error('supabase-js 를 불러올 수 없습니다')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function ensure() {
    if (!configured()) return Promise.reject(new Error('동기화가 설정되지 않았습니다'));
    if (client) return Promise.resolve(client);
    return loadVendor().then(function () {
      var c = cfg();
      client = window.supabase.createClient(c.url, c.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: 'dsm.auth'
        }
      });
      client.auth.onAuthStateChange(function (_evt, session) {
        user = session ? session.user : null;
        emit(user ? 'signed-in' : 'signed-out');
      });
      return client.auth.getSession().then(function (r) {
        user = (r.data && r.data.session) ? r.data.session.user : null;
        return client;
      });
    });
  }

  /* 이전에 로그인한 적이 있으면(저장된 세션이 있으면) 조용히 복구한다 */
  function hasStoredSession() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        if (localStorage.key(i).indexOf('dsm.auth') === 0) return true;
      }
    } catch (e) { }
    return false;
  }

  function init() {
    if (!configured()) return Promise.resolve(null);
    if (!hasStoredSession()) return Promise.resolve(null);
    return ensure().then(function () {
      if (user) return sync().then(function () { return user; });
      return null;
    }).catch(function () { return null; });
  }

  /* ---------------- 로그인 ---------------- */

  function signIn(email) {
    return ensure().then(function (c) {
      return c.auth.signInWithOtp({
        email: email,
        options: { emailRedirectTo: location.origin + location.pathname }
      });
    }).then(function (r) {
      if (r.error) throw r.error;
      return true;
    });
  }

  function signOut() {
    if (!client) return Promise.resolve();
    return client.auth.signOut().then(function () {
      user = null;
      emit('signed-out');
    });
  }

  function currentUser() { return user; }

  function lastSync() {
    var v = localStorage.getItem(LAST_KEY);
    return v ? new Date(+v) : null;
  }

  /* ---------------- 동기화 ---------------- */

  function pushSessions(c) {
    var rows = DSM.Stats.pendingChunks();

    // 로그인 전부터 이 폰에 있던 기록은 한 번만 올린다
    var flagKey = BACKFILL_DONE + '.' + user.id;
    if (!localStorage.getItem(flagKey)) {
      var back = DSM.Stats.backfillChunks();
      var seen = {};
      rows.forEach(function (r) { seen[r.id] = true; });
      back.forEach(function (r) { if (!seen[r.id]) rows.push(r); });
    }

    if (!rows.length) return Promise.resolve([]);

    var payload = rows.map(function (r) {
      return {
        id: r.id, user_id: user.id, day: r.day,
        dance_id: r.dance_id, seconds: r.seconds
      };
    });

    return c.from('practice_sessions').upsert(payload, { onConflict: 'id' })
      .then(function (res) {
        if (res.error) throw res.error;
        localStorage.setItem(flagKey, '1');
        return rows.map(function (r) { return r.id; });
      });
  }

  function pullTotals(c) {
    return c.from('practice_totals').select('day,total_seconds,by_dance')
      .then(function (res) {
        if (res.error) throw res.error;
        DSM.Stats.replaceTotals(res.data || []);
      });
  }

  function pushSettings(c, settings, goalSeconds) {
    return c.from('settings').upsert({
      user_id: user.id, data: settings, goal_seconds: goalSeconds
    }, { onConflict: 'user_id' }).then(function (res) {
      if (res.error) throw res.error;
    });
  }

  function pullSettings(c) {
    return c.from('settings').select('data,goal_seconds,updated_at').maybeSingle()
      .then(function (res) {
        if (res.error) throw res.error;
        return res.data || null;
      });
  }

  function pushTracks(c, tracks) {
    if (!tracks.length) return Promise.resolve();
    var payload = tracks.map(function (t) {
      return {
        user_id: user.id, id: t.id, name: t.name, dance_id: t.danceId || null,
        bpm: t.bpm, offset_sec: t.offset || 0, start_bar: t.startBar || 0
      };
    });
    return c.from('tracks').upsert(payload, { onConflict: 'user_id,id' })
      .then(function (res) { if (res.error) throw res.error; });
  }

  function pullTracks(c) {
    return c.from('tracks').select('id,name,dance_id,bpm,offset_sec,start_bar')
      .then(function (res) {
        if (res.error) throw res.error;
        return res.data || [];
      });
  }

  /* hooks 로 앱의 설정·음원 목록을 주고받는다 (app.js 가 채운다) */
  var hooks = { getSettings: null, applySettings: null, getTracks: null, applyTracks: null };
  function setHooks(h) { hooks = h; }

  function sync() {
    if (!user || busy) return Promise.resolve(false);
    busy = true;
    emit('syncing');

    return ensure().then(function (c) {
      return pushSessions(c).then(function (ids) {
        return pullTotals(c).then(function () {
          if (ids.length) DSM.Stats.markChunksSynced(ids);
        });
      }).then(function () {
        if (!hooks.getSettings) return null;
        var local = hooks.getSettings();
        return pullSettings(c).then(function (remote) {
          // 서버 값이 더 최근이면 받아오고, 아니면 올린다
          var localAt = +(localStorage.getItem('dsm.settingsAt') || 0);
          var remoteAt = remote ? +new Date(remote.updated_at) : 0;
          if (remote && remoteAt > localAt) {
            hooks.applySettings(remote.data, remote.goal_seconds);
            localStorage.setItem('dsm.settingsAt', String(remoteAt));
          } else {
            return pushSettings(c, local.settings, local.goalSeconds).then(function () {
              localStorage.setItem('dsm.settingsAt', String(Date.now()));
            });
          }
        });
      }).then(function () {
        if (!hooks.getTracks) return null;
        return hooks.getTracks().then(function (local) {
          return pushTracks(c, local).then(function () { return pullTracks(c); });
        }).then(function (remote) {
          if (hooks.applyTracks) return hooks.applyTracks(remote);
        });
      });
    }).then(function () {
      localStorage.setItem(LAST_KEY, String(Date.now()));
      busy = false;
      emit('synced');
      return true;
    }).catch(function (err) {
      busy = false;
      emit('error', (err && err.message) || String(err));
      return false;
    });
  }

  return {
    configured: configured,
    init: init,
    signIn: signIn,
    signOut: signOut,
    currentUser: currentUser,
    sync: sync,
    lastSync: lastSync,
    onChange: onChange,
    setHooks: setHooks,
    isBusy: function () { return busy; }
  };
})();
