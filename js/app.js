/* 화면과 상태 */
window.DSM = window.DSM || {};

DSM.App = (function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var SET_KEY = 'dsm.settings';

  var S = {
    voicePack: 'ko-heami',
    countStyle: {},        // danceId -> styleId ('off' 가능, 없으면 종목 기본값)
    countInMode: '8',
    theme: 'click',
    vol: { click: 0.9, voice: 0.9, music: 0.8 },
    simple: false,
    phraseAccent: true,
    wakeOn: true,
    lastDance: null,
    bpmByDance: {},
    musicLoop: false
  };

  var cur = null;          // 현재 종목
  var bpm = 120;
  var beatEls = [];        // 슬롯 -> 도트 엘리먼트 (없으면 null)
  var wakeLock = null;
  var flushTimer = null;
  var uiTimer = null;
  var rangeDays = 7;
  var recIndex = 0;
  var recorder = null, recChunks = [], recStream = null;
  var USER_PACK = 'user-voice';
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /* ---------------- 유틸 ---------------- */

  function save() {
    try { localStorage.setItem(SET_KEY, JSON.stringify(S)); } catch (e) { /* 무시 */ }
  }

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(SET_KEY));
      if (raw) {
        Object.keys(raw).forEach(function (k) {
          if (k === 'vol' && raw.vol) { S.vol.click = raw.vol.click; S.vol.voice = raw.vol.voice; S.vol.music = raw.vol.music; }
          else if (S.hasOwnProperty(k)) S[k] = raw[k];
        });
      }
    } catch (e) { /* 기본값 사용 */ }
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  function showView(id) {
    ['view-home', 'view-player', 'view-stats'].forEach(function (v) {
      $(v).classList.toggle('is-active', v === id);
    });
    window.scrollTo(0, 0);
  }

  var openSheetEl = null;
  function openSheet(el) {
    closeSheet();
    openSheetEl = el;
    el.hidden = false;
    $('backdrop').hidden = false;
  }
  function closeSheet() {
    if (openSheetEl) openSheetEl.hidden = true;
    openSheetEl = null;
    $('backdrop').hidden = true;
    DSM.Audio.previewMusicStop();
    $('align-play').textContent = '▶ 듣기';
  }

  /* 길게 누르면 점점 빨라지는 반복 — 템포 미세조정에 필요 */
  function holdRepeat(el, fn) {
    var first = null, next = null, delay;
    function tick() {
      fn();
      delay = Math.max(45, delay * 0.82);
      next = setTimeout(tick, delay);
    }
    function down(e) {
      e.preventDefault();
      fn();
      delay = 220;
      first = setTimeout(tick, 420);
    }
    function up() { clearTimeout(first); clearTimeout(next); }
    el.addEventListener('pointerdown', down);
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      el.addEventListener(ev, up);
    });
  }

  /* ---------------- 홈 ---------------- */

  function renderHome() {
    ['standard', 'latin'].forEach(function (style) {
      var wrap = $('grid-' + style);
      wrap.innerHTML = '';
      DSM.Dances.list.filter(function (d) { return d.style === style; }).forEach(function (d) {
        var b = document.createElement('button');
        b.className = 'tile ' + (style === 'standard' ? 'std' : 'lat');
        var saved = S.bpmByDance[d.id];
        var shown = saved || d.bpm.def;
        var pct = Math.round(shown / d.bpm.def * 100);
        b.innerHTML = '<span class="tname">' + d.ko + '</span>' +
          '<span class="tmeta"><b>' + shown + '</b> BPM · ' + d.beatsPerBar + '/4' +
          (pct !== 100 ? ' · ' + pct + '%' : '') + '</span>';
        b.addEventListener('click', function () { openDance(d.id); });
        wrap.appendChild(b);
      });
    });
    renderToday();
    $('silent-note').hidden = !isIOS;
  }

  function renderToday() {
    var t = DSM.Stats.today();
    var g = DSM.Stats.goal();
    $('today-val').textContent = DSM.Stats.fmt(t);
    $('today-fill').style.width = Math.min(100, t / g * 100) + '%';
    var st = DSM.Stats.streak();
    $('today-sub').textContent = '목표 ' + Math.round(g / 60) + '분' + (st > 1 ? ' · ' + st + '일 연속' : '');
  }

  /* ---------------- 플레이어 ---------------- */

  function openDance(id) {
    var d = DSM.Dances.get(id);
    if (!d) return;
    if (cur && cur.id !== id && DSM.Audio.hasMusic()) {
      DSM.Audio.detachMusic();
      DSM.Music.clear();
      $('musicbar').hidden = true;
      $('btn-music').classList.remove('has-music');
    }
    DSM.Audio.stop();
    cur = d;
    S.lastDance = id;
    bpm = S.bpmByDance[id] || d.bpm.def;
    save();
    renderPlayer();
    showView('view-player');
    // 종목별 딥링크 — 자주 하는 종목만 따로 홈 화면에 추가해 둘 수 있다
    try { history.replaceState(null, '', '#' + id); } catch (e) { /* file:// 등 */ }
  }

  function goHome() {
    stopAll();
    renderHome();
    showView('view-home');
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
  }

  function renderPlayer() {
    var d = cur;
    $('p-name').textContent = d.ko;
    $('p-meta').textContent = d.beatsPerBar + '/4 · 공식 ' + d.mpm.min + '–' + d.mpm.max + ' MPM';

    // 비트 도트: 박은 큰 원, 클릭이 있는 분할박은 작은 점
    var wrap = $('beats');
    wrap.innerHTML = '';
    beatEls = new Array(d.slotsPerBar).fill(null);
    var pat = S.simple ? DSM.Dances.simpleClick(d) : d.click;
    for (var i = 0; i < d.slotsPerBar; i++) {
      var onBeat = (i % d.tpb) === 0;
      if (!onBeat && !pat[i]) continue;
      var el = document.createElement('div');
      el.className = 'beat' + (onBeat ? '' : ' sub') + (i === 0 ? ' head' : '');
      if (onBeat) el.textContent = String(i / d.tpb + 1);
      wrap.appendChild(el);
      beatEls[i] = el;
    }

    // 공식 경기 범위를 슬라이더 위에 띠로 표시
    var lo = d.bpm.min / d.bpm.def * 100;
    var hi = d.bpm.max / d.bpm.def * 100;
    var band = $('official-band');
    band.style.left = ((lo - 40) / 80 * 100) + '%';
    band.style.width = ((hi - lo) / 80 * 100) + '%';

    var chips = $('pct-chips');
    chips.innerHTML = '';
    [70, 80, 90, 100].forEach(function (p) {
      var b = document.createElement('button');
      b.textContent = p + '%';
      b.dataset.pct = p;
      b.addEventListener('click', function () { setBpm(Math.round(d.bpm.def * p / 100)); });
      chips.appendChild(b);
    });

    setBpm(bpm);
    paintTempo();          // 음원이 붙어 있으면 setBpm 이 일찍 빠져나오므로 여기서 한 번 더
    paintTransport();
    $('bar-num').textContent = '준비';
    $('phrase-wrap').hidden = true;
  }

  function setBpm(v) {
    if (DSM.Audio.hasMusic()) return;              // 곡 템포에 잠김
    v = Math.max(20, Math.min(400, Math.round(v)));
    bpm = v;
    S.bpmByDance[cur.id] = v;
    save();
    DSM.Audio.setBpm(v);
    paintTempo();
  }

  function paintTempo() {
    var d = cur;
    var pct = bpm / d.bpm.def * 100;
    $('bpm-input').value = bpm;
    var mpm = bpm / d.beatsPerBar;
    $('tempo-sub').textContent = (Math.round(mpm * 10) / 10) + ' MPM · 공식 대비 ' + Math.round(pct) + '%';
    $('pct-slider').value = Math.max(40, Math.min(120, Math.round(pct)));
    var chips = $('pct-chips').children;
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('on', Math.round(pct) === +chips[i].dataset.pct);
    }
    var locked = DSM.Audio.hasMusic();
    $('pct-slider').disabled = locked;
    $('bpm-minus').disabled = locked;
    $('bpm-plus').disabled = locked;
    $('bpm-input').disabled = locked;
    if (locked) $('tempo-sub').textContent = (Math.round(mpm * 10) / 10) + ' MPM · 곡 템포에 고정';
  }

  function paintTransport() {
    var s = DSM.Audio.status();
    var playing = (s === 'playing' || s === 'countin');
    var btn = $('btn-play');
    btn.textContent = playing ? '❚❚' : '▶';
    btn.classList.toggle('on', playing);
    btn.setAttribute('aria-label', playing ? '일시정지' : '시작');
  }

  function clearBeats() {
    beatEls.forEach(function (el) { if (el) el.classList.remove('on'); });
  }

  function onTick(ev) {
    if (ev.phase === 'stopped') {
      clearBeats();
      $('countin').hidden = true;
      $('bar-num').textContent = '준비';
      $('phrase-wrap').hidden = true;
      return;
    }
    if (ev.phase === 'countin') {
      $('countin').hidden = false;
      $('countin-num').textContent = ev.remaining;
      return;
    }
    $('countin').hidden = true;

    // 소리 없는 슬롯에서는 직전 점등을 그대로 둔다 (깜빡임 방지)
    if (beatEls[ev.slot]) {
      clearBeats();
      beatEls[ev.slot].classList.add('on');
    }
    if (ev.slot === 0) {
      $('bar-num').textContent = (ev.bar + 1) + '마디';
      $('phrase-wrap').hidden = false;
      $('phrase-num').textContent = ev.phrase + 1;
    }
  }

  /* ---------------- 재생 컨트롤 ---------------- */

  function audioOpts() {
    return {
      theme: S.theme,
      phraseAccent: S.phraseAccent,
      simple: S.simple,
      countInMode: S.countInMode,
      voiceStyleId: S.countStyle[cur.id]
    };
  }

  function playPause() {
    var s = DSM.Audio.status();
    if (s === 'playing' || s === 'countin') {
      DSM.Audio.pause();
      flushStats();
      releaseWake();
      stopTimers();
    } else if (s === 'paused') {
      DSM.Audio.resume();
      acquireWake();
      startTimers();
    } else {
      DSM.Audio.start(cur, bpm, audioOpts());
      acquireWake();
      startTimers();
    }
    paintTransport();
  }

  function stopAll() {
    DSM.Audio.stop();
    flushStats();
    releaseWake();
    paintTransport();
    stopTimers();
    renderToday();
  }

  /* ---------------- 화면 꺼짐 방지 ---------------- */

  function acquireWake() {
    if (!S.wakeOn || !('wakeLock' in navigator)) return;
    try {
      navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; },
        function () { /* 거부되면 그냥 넘어간다 */ });
    } catch (e) { /* 미지원 */ }
  }

  function releaseWake() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) { } wakeLock = null; }
  }

  /* ---------------- 연습 시간 누적 ---------------- */

  function flushStats() {
    if (!cur) return;
    var sec = DSM.Audio.consumeElapsed();
    if (sec > 0) DSM.Stats.add(cur.id, sec);
  }

  function startTimers() {
    stopTimers();
    flushTimer = setInterval(flushStats, 5000);
    if (DSM.Audio.hasMusic()) uiTimer = setInterval(paintMusicBar, 250);
  }

  function stopTimers() {
    clearInterval(flushTimer); flushTimer = null;
    clearInterval(uiTimer); uiTimer = null;
  }

  /* ---------------- 설정 시트 ---------------- */

  var THEMES = [{ id: 'click', name: '클릭' }, { id: 'wood', name: '우드블록' }, { id: 'beep', name: '비프' }];

  function renderCountInSeg() {
    renderSeg('countin-mode', DSM.Dances.COUNT_IN_MODES, S.countInMode, function (id) {
      S.countInMode = id; save();
      renderCountInSeg();
      paintCountInHint();
      if (cur) DSM.Audio.setOptions(audioOpts());
    });
  }

  function renderThemeSeg() {
    renderSeg('theme-seg', THEMES, S.theme, function (id) {
      S.theme = id; save();
      renderThemeSeg();
      if (cur) DSM.Audio.setOptions(audioOpts());
      DSM.Audio.preview('A');
    });
  }

  function openSettings() {
    renderVoiceList();
    renderCountStyle();
    renderCountInSeg();
    paintCountInHint();
    renderThemeSeg();
    $('vol-click').value = Math.round(S.vol.click * 100);
    $('vol-voice').value = Math.round(S.vol.voice * 100);
    $('vol-music').value = Math.round(S.vol.music * 100);
    $('opt-simple').checked = S.simple;
    $('opt-phrase').checked = S.phraseAccent;
    $('opt-wake').checked = S.wakeOn;
    openSheet($('sheet-settings'));
  }

  function paintCountInHint() {
    if (!cur) { $('countin-hint').textContent = ''; return; }
    var n = DSM.Dances.resolveCountIn(cur, S.countInMode);
    if (n === 0) { $('countin-hint').textContent = '예비박 없이 바로 시작합니다.'; return; }
    var bars = n / cur.beatsPerBar;
    var extra = (cur.beatsPerBar === 3 && S.countInMode === '8')
      ? ' — 3박자라 8박 대신 6박(2마디)입니다. 8박이면 본박이 마디 중간에서 시작해 어긋납니다.'
      : '';
    $('countin-hint').textContent = cur.ko + ': ' + n + '박 (' + bars + '마디)' + extra;
  }

  function renderSeg(elId, items, active, onPick) {
    var wrap = $(elId);
    wrap.innerHTML = '';
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.textContent = it.name;
      b.className = (it.id === active) ? 'on' : '';
      b.addEventListener('click', function () { onPick(it.id); });
      wrap.appendChild(b);
    });
  }

  function renderCountStyle() {
    if (!cur) return;
    var items = cur.voiceStyles.map(function (v) { return { id: v.id, name: v.name }; });
    items.push({ id: 'off', name: '끄기' });
    var active = S.countStyle[cur.id] || cur.voiceStyles[0].id;
    renderSeg('count-style', items, active, function (id) {
      S.countStyle[cur.id] = id; save();
      renderCountStyle();
      DSM.Audio.setOptions(audioOpts());
      renderPlayer();
    });
  }

  function renderVoiceList() {
    var wrap = $('voice-list');
    wrap.innerHTML = '';
    DSM.Voices.list().forEach(function (p) {
      var b = document.createElement('button');
      b.className = (p.id === S.voicePack) ? 'on' : '';
      var n = DSM.Voices.coverage(p.id);
      b.innerHTML = '<span class="rname">' + p.name + '</span>' +
        '<span class="rmeta">' + (n ? n + '/13' : '') + '</span>';
      b.addEventListener('click', function () {
        S.voicePack = p.id; save();
        DSM.Voices.select(p.id).then(function () { renderVoiceList(); });
      });
      if (p.source === 'user') {
        var del = document.createElement('span');
        del.className = 'rdel';
        del.textContent = '삭제';
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          DSM.Voices.deletePack(p.id).then(function () {
            if (S.voicePack === p.id) { S.voicePack = DSM.Voices.FALLBACK_ID; save(); }
            renderVoiceList();
          });
        });
        b.appendChild(del);
      }
      wrap.appendChild(b);
    });

    var hint = $('voice-hint');
    if (location.protocol === 'file:') {
      hint.innerHTML = '<b>file:// 로 열면 음성이 로드되지 않습니다.</b> 배포한 https 주소에서 확인하세요. 클릭음은 정상 동작합니다.';
    } else if (!DSM.Voices.coverage(S.voicePack)) {
      hint.textContent = '음성 파일을 불러오지 못했습니다. 클릭음만 나옵니다.';
    } else {
      hint.textContent = '음절 파일 13개로 이루어진 폴더가 곧 하나의 목소리입니다. 언제든 바꿀 수 있습니다.';
    }
  }

  /* ---------------- 음원 시트 ---------------- */

  var align = null;      // { bpm, offset, rmsMs, taps }
  var startBar = 0;

  function openMusic() {
    renderTrackList();
    var t = DSM.Music.get();
    if (t) {
      $('align-panel').hidden = false;
      align = t.align;
      startBar = t.startBar || 0;
      paintAlign();
    } else {
      $('align-panel').hidden = true;
      align = null;
    }
    $('music-loop').checked = S.musicLoop;
    openSheet($('sheet-music'));
  }

  function renderTrackList() {
    DSM.Music.listSaved().then(function (rows) {
      $('saved-wrap').hidden = rows.length === 0;
      var wrap = $('track-list');
      wrap.innerHTML = '';
      rows.forEach(function (r) {
        var b = document.createElement('button');
        b.innerHTML = '<span class="tkname">' + r.name + '</span>' +
          '<span class="tkmeta">' + Math.round(r.bpm) + ' BPM</span>';
        b.addEventListener('click', function () {
          DSM.Music.open(r.id).then(function (t) {
            if (!t) return;
            align = t.align;
            startBar = t.startBar || 0;
            $('align-panel').hidden = false;
            DSM.Music.tapReset();
            $('tap-count').textContent = '0';
            paintAlign();
          });
        });
        var del = document.createElement('span');
        del.className = 'tkdel';
        del.textContent = '삭제';
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          DSM.Music.remove(r.id).then(renderTrackList);
        });
        b.appendChild(del);
        wrap.appendChild(b);
      });
    });
  }

  function paintAlign() {
    var res = $('align-result');
    if (!align) {
      res.textContent = '아직 계산 전 — 곡을 들으며 4번 이상 탭하세요.';
      res.className = 'alignresult';
      $('tune-wrap').hidden = true;
      $('align-apply').disabled = true;
      return;
    }
    var mpm = align.bpm / (cur ? cur.beatsPerBar : 4);
    res.innerHTML = '<b>' + align.bpm.toFixed(1) + ' BPM</b> · ' + mpm.toFixed(1) + ' MPM<br>' +
      '첫 다운비트 ' + align.offset.toFixed(2) + '초' +
      (align.rmsMs !== undefined ? ' · 탭 편차 ±' + Math.round(align.rmsMs) + 'ms' : '');
    res.className = 'alignresult good';
    $('tune-wrap').hidden = false;
    $('align-apply').disabled = false;
    $('tune-bpm').textContent = align.bpm.toFixed(1);
    $('tune-off').textContent = align.offset.toFixed(2) + 's';
    $('tune-bar').textContent = (startBar + 1);
  }

  function applyMusic() {
    var t = DSM.Music.get();
    if (!t || !align) return;
    DSM.Music.setAlign(align);
    t.startBar = startBar;
    t.danceId = cur ? cur.id : null;
    DSM.Audio.previewMusicStop();
    DSM.Audio.attachMusic(t.buffer, { bpm: align.bpm, offset: align.offset });
    DSM.Audio.setStartBar(startBar, cur.beatsPerBar);
    DSM.Audio.setMusicLoop(S.musicLoop);
    bpm = Math.round(align.bpm);
    DSM.Music.save().then(renderTrackList);
    $('musicbar').hidden = false;
    $('m-name').textContent = t.name;
    $('btn-music').classList.add('has-music');
    paintTempo();
    paintMusicBar();
    closeSheet();
    toast('곡에 맞춰 카운트합니다');
  }

  function paintMusicBar() {
    if (!DSM.Audio.hasMusic()) return;
    var pos = DSM.Audio.musicPosition();
    var dur = DSM.Audio.musicDuration();
    $('m-fill').style.width = (dur ? pos / dur * 100 : 0) + '%';
    $('m-time').textContent = DSM.Music.fmtTime(pos) + ' / ' + DSM.Music.fmtTime(dur);
    var a = DSM.Music.get();
    $('m-info').textContent = a && a.align ? a.align.bpm.toFixed(1) + ' BPM' : '';
  }

  function detachMusic() {
    DSM.Audio.stop();
    DSM.Audio.detachMusic();
    DSM.Music.clear();
    align = null;
    $('musicbar').hidden = true;
    $('btn-music').classList.remove('has-music');
    bpm = S.bpmByDance[cur.id] || cur.bpm.def;
    paintTempo();
    paintTransport();
    toast('음원을 해제했습니다');
  }

  /* ---------------- 녹음 시트 ---------------- */

  function openRecord() {
    recIndex = 0;
    paintRecord();
    openSheet($('sheet-record'));
  }

  function paintRecord() {
    var key = DSM.Voices.SYLLABLES[recIndex];
    $('rec-prog').textContent = (recIndex + 1) + ' / ' + DSM.Voices.SYLLABLES.length;
    $('rec-word').textContent = DSM.Voices.LABEL_KO[key] || key;
    $('rec-status').textContent = '키: ' + key;
  }

  function startRec() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('이 브라우저에서는 녹음을 지원하지 않습니다'); return;
    }
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      toast('녹음은 https 주소에서만 됩니다'); return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      recStream = stream;
      recChunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = function (e) { if (e.data.size) recChunks.push(e.data); };
      recorder.onstop = function () {
        var blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
        stream.getTracks().forEach(function (t) { t.stop(); });
        recStream = null;
        blob.arrayBuffer().then(function (ab) {
          var key = DSM.Voices.SYLLABLES[recIndex];
          var name = $('pack-name').value || '내 목소리';
          return DSM.Voices.saveSyllable(USER_PACK, name, key, ab);
        }).then(function () {
          $('rec-status').textContent = '저장됨 — 들어보고 괜찮으면 다음으로';
          S.voicePack = USER_PACK; save();
          return DSM.Voices.select(USER_PACK);
        }).catch(function (err) {
          $('rec-status').textContent = '저장 실패: ' + err.message;
        });
      };
      recorder.start();
      $('rec-btn').classList.add('rec');
      $('rec-btn').textContent = '녹음 중…';
    }).catch(function () {
      toast('마이크 권한이 필요합니다');
    });
  }

  function stopRec() {
    if (recorder && recorder.state === 'recording') recorder.stop();
    recorder = null;
    $('rec-btn').classList.remove('rec');
    $('rec-btn').textContent = '누르고 말하기';
  }

  /* ---------------- 기록 화면 ---------------- */

  function renderStats() {
    var cards = $('stat-cards');
    cards.innerHTML = '';
    [
      { v: DSM.Stats.fmt(DSM.Stats.today()), l: '오늘' },
      { v: DSM.Stats.streak() + '일', l: '연속' },
      { v: DSM.Stats.fmt(DSM.Stats.grandTotal()), l: '누적' }
    ].forEach(function (c) {
      var el = document.createElement('div');
      el.className = 'statcard';
      el.innerHTML = '<b>' + c.v + '</b><span>' + c.l + '</span>';
      cards.appendChild(el);
    });

    var rows = DSM.Stats.recent(rangeDays);
    var max = Math.max(60, Math.max.apply(null, rows.map(function (r) { return r.total; })));
    var chart = $('chart');
    chart.innerHTML = '';
    var wd = ['일', '월', '화', '수', '목', '금', '토'];
    var todayKey = DSM.Stats.dayKey();
    rows.forEach(function (r, i) {
      var c = document.createElement('div');
      c.className = 'cbar' + (r.total > 0 ? ' has' : '') + (r.date === todayKey ? ' today' : '');
      var label = rangeDays <= 7 ? wd[r.day.getDay()]
        : (i % 5 === 0 || i === rows.length - 1 ? String(r.day.getDate()) : '');
      c.innerHTML = '<i style="height:' + (r.total / max * 100) + '%"></i><span>' + label + '</span>';
      c.title = r.date + ' ' + DSM.Stats.fmt(r.total);
      chart.appendChild(c);
    });

    var by = DSM.Stats.totalsByDance(rangeDays);
    var ids = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; });
    var top = ids.length ? by[ids[0]] : 1;
    var wrap = $('by-dance');
    wrap.innerHTML = '';
    if (!ids.length) {
      wrap.innerHTML = '<p class="hint">아직 기록이 없습니다. 연습을 시작하면 여기에 쌓입니다.</p>';
    }
    ids.forEach(function (id) {
      var d = DSM.Dances.get(id);
      var row = document.createElement('div');
      row.className = 'brow';
      row.innerHTML = '<span class="bname">' + (d ? d.ko : id) + '</span>' +
        '<span class="bfill"><i style="width:' + (by[id] / top * 100) + '%;background:' +
        (d && d.style === 'latin' ? 'var(--lat)' : 'var(--std)') + '"></i></span>' +
        '<span class="bval">' + DSM.Stats.fmt(by[id]) + '</span>';
      wrap.appendChild(row);
    });

    $('goal-input').value = Math.round(DSM.Stats.goal() / 60);
  }

  /* ---------------- 초기화 ---------------- */

  function bind() {
    // 홈
    $('go-stats').addEventListener('click', function () { renderStats(); showView('view-stats'); });
    $('today-card').addEventListener('click', function () { renderStats(); showView('view-stats'); });
    $('stats-back').addEventListener('click', function () { renderHome(); showView('view-home'); });

    // 플레이어
    $('go-home').addEventListener('click', goHome);
    $('go-settings').addEventListener('click', openSettings);
    $('btn-play').addEventListener('click', playPause);
    $('btn-stop').addEventListener('click', stopAll);
    $('btn-music').addEventListener('click', openMusic);

    holdRepeat($('bpm-minus'), function () { setBpm(bpm - 1); });
    holdRepeat($('bpm-plus'), function () { setBpm(bpm + 1); });

    $('pct-slider').addEventListener('input', function () {
      setBpm(Math.round(cur.bpm.def * (+this.value) / 100));
    });
    $('bpm-input').addEventListener('change', function () { setBpm(+this.value); });
    $('bpm-input').addEventListener('focus', function () { this.select(); });

    $('m-detach').addEventListener('click', detachMusic);
    $('m-edit').addEventListener('click', openMusic);

    // 시트 공통
    $('backdrop').addEventListener('click', closeSheet);
    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
      b.addEventListener('click', closeSheet);
    });

    // 설정
    ['click', 'voice', 'music'].forEach(function (bus) {
      $('vol-' + bus).addEventListener('input', function () {
        S.vol[bus] = (+this.value) / 100;
        DSM.Audio.setVolume(bus, S.vol[bus]);
        save();
      });
    });
    $('opt-simple').addEventListener('change', function () {
      S.simple = this.checked; save();
      if (cur) { DSM.Audio.setOptions(audioOpts()); renderPlayer(); }
    });
    $('opt-phrase').addEventListener('change', function () {
      S.phraseAccent = this.checked; save();
      if (cur) DSM.Audio.setOptions(audioOpts());
    });
    $('opt-wake').addEventListener('change', function () {
      S.wakeOn = this.checked; save();
      if (!S.wakeOn) releaseWake();
      else if (DSM.Audio.status() === 'playing') acquireWake();
    });
    $('voice-preview').addEventListener('click', function () {
      if (!cur) { DSM.Audio.previewVoice('1'); return; }
      var seq = DSM.Dances.voiceStyle(cur, S.countStyle[cur.id]).seq;
      var i = 0, delay = 0;
      seq.forEach(function (k) {
        if (!k) return;
        setTimeout(function () { DSM.Audio.previewVoice(k); }, delay);
        delay += 420;
        i++;
      });
      if (!i) toast('이 카운트 방식에는 음성이 없습니다');
    });
    $('voice-record').addEventListener('click', openRecord);

    // 녹음
    $('rec-btn').addEventListener('pointerdown', function (e) { e.preventDefault(); startRec(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      $('rec-btn').addEventListener(ev, stopRec);
    });
    $('rec-prev').addEventListener('click', function () {
      recIndex = (recIndex - 1 + DSM.Voices.SYLLABLES.length) % DSM.Voices.SYLLABLES.length;
      paintRecord();
    });
    $('rec-next').addEventListener('click', function () {
      recIndex = (recIndex + 1) % DSM.Voices.SYLLABLES.length;
      paintRecord();
    });
    $('rec-play').addEventListener('click', function () {
      DSM.Audio.previewVoice(DSM.Voices.SYLLABLES[recIndex]);
    });
    $('rec-done').addEventListener('click', function () {
      renderVoiceList();
      closeSheet();
      openSheet($('sheet-settings'));
    });
    $('import-voice').addEventListener('click', function () { $('import-voice-file').click(); });
    $('import-voice-file').addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []);
      if (!files.length) return;
      var name = $('pack-name').value || '내 목소리';
      var jobs = files.map(function (f) {
        var key = f.name.replace(/\.[^.]+$/, '').toLowerCase();
        if (DSM.Voices.SYLLABLES.indexOf(key) < 0) return Promise.resolve(0);
        return f.arrayBuffer().then(function (ab) {
          return DSM.Voices.saveSyllable(USER_PACK, name, key, ab);
        }).then(function () { return 1; }).catch(function () { return 0; });
      });
      Promise.all(jobs).then(function (r) {
        var n = r.reduce(function (a, b) { return a + b; }, 0);
        S.voicePack = USER_PACK; save();
        return DSM.Voices.select(USER_PACK).then(function () {
          toast(n + '개 음절을 넣었습니다');
          renderVoiceList();
        });
      });
      this.value = '';
    });

    // 음원
    $('pick-file').addEventListener('click', function () { $('music-file').click(); });
    $('music-file').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      DSM.Audio.init();
      toast('불러오는 중…');
      DSM.Music.loadFile(f).then(function (t) {
        align = null; startBar = 0;
        DSM.Music.tapReset();
        $('tap-count').textContent = '0';
        $('align-panel').hidden = false;
        paintAlign();
        toast(t.name + ' (' + DSM.Music.fmtTime(t.buffer.duration) + ')');
      }).catch(function () {
        toast('이 파일은 열 수 없습니다 (DRM 이거나 지원하지 않는 형식)');
      });
      this.value = '';
    });

    $('align-play').addEventListener('click', function () {
      var t = DSM.Music.get();
      if (!t) return;
      if (DSM.Audio.previewMusicPlaying()) {
        DSM.Audio.previewMusicStop();
        this.textContent = '▶ 듣기';
      } else {
        DSM.Audio.previewMusicStart(t.buffer, 0);
        this.textContent = '■ 멈춤';
      }
    });
    $('align-reset').addEventListener('click', function () {
      DSM.Music.tapReset();
      align = null;
      $('tap-count').textContent = '0';
      paintAlign();
    });
    $('tap-pad').addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (!DSM.Audio.previewMusicPlaying()) { toast('먼저 ▶ 듣기를 누르세요'); return; }
      var r = DSM.Music.tap(DSM.Audio.previewMusicPos());
      $('tap-count').textContent = DSM.Music.tapCount();
      if (r) { align = r; paintAlign(); }
    });
    $('tune-wrap').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || !align) return;
      var t = DSM.Music.get();
      if (!t) return;
      // 미세조정은 저장된 align 을 직접 고치므로 먼저 반영해 둔다
      if (!t.align) DSM.Music.setAlign(align);

      if (b.dataset.bpm) align = DSM.Music.nudgeBpm(parseFloat(b.dataset.bpm)) || align;
      else if (b.dataset.off) align = DSM.Music.nudgeOffset(parseFloat(b.dataset.off)) || align;
      else if (b.dataset.scale) align = DSM.Music.scaleBpm(parseFloat(b.dataset.scale)) || align;
      else if (b.dataset.bar) startBar = Math.max(0, startBar + parseInt(b.dataset.bar, 10));
      else return;

      // 이미 재생에 물려 있으면 즉시 반영해서 귀로 확인하며 맞출 수 있게 한다
      if (DSM.Audio.hasMusic() && cur) {
        DSM.Audio.updateAlign({ bpm: align.bpm, offset: align.offset }, cur.beatsPerBar);
        DSM.Audio.setStartBar(startBar, cur.beatsPerBar);
      }
      paintAlign();
    });
    $('music-loop').addEventListener('change', function () {
      S.musicLoop = this.checked; save();
      DSM.Audio.setMusicLoop(S.musicLoop);
    });
    $('align-apply').addEventListener('click', applyMusic);

    // 기록
    $('range-seg').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      rangeDays = +b.dataset.days;
      Array.prototype.forEach.call(this.children, function (c) { c.classList.toggle('on', c === b); });
      renderStats();
    });
    $('goal-save').addEventListener('click', function () {
      DSM.Stats.setGoal((+$('goal-input').value || 30) * 60);
      renderStats(); renderToday();
      toast('목표를 저장했습니다');
    });
    $('export-stats').addEventListener('click', function () {
      var blob = new Blob([DSM.Stats.exportJson()], { type: 'application/json' });
      var name = 'dancesport-practice-' + DSM.Stats.dayKey() + '.json';
      var file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: '연습 기록' }).catch(function () { });
      } else {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      }
    });
    $('import-stats').addEventListener('click', function () { $('import-file').click(); });
    $('import-file').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      f.text().then(function (txt) {
        try { DSM.Stats.importJson(txt); renderStats(); renderToday(); toast('기록을 합쳤습니다'); }
        catch (e) { toast('파일을 읽을 수 없습니다'); }
      });
      this.value = '';
    });
    $('reset-stats').addEventListener('click', function () {
      if (!confirm('연습 기록을 모두 지울까요? 되돌릴 수 없습니다.')) return;
      DSM.Stats.reset(); renderStats(); renderToday();
    });

    // 백그라운드 처리
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { flushStats(); }
      else if (DSM.Audio.status() === 'playing' || DSM.Audio.status() === 'countin') { acquireWake(); }
    });
    window.addEventListener('pagehide', flushStats);
  }

  function init() {
    load();
    bind();

    var ctx = DSM.Audio.init();
    DSM.Music.init(ctx);
    DSM.Audio.onTick(onTick);
    DSM.Audio.onMusicEnd(function () { stopAll(); toast('곡이 끝났습니다'); });
    DSM.Audio.setVolume('click', S.vol.click);
    DSM.Audio.setVolume('voice', S.vol.voice);
    DSM.Audio.setVolume('music', S.vol.music);

    DSM.Voices.init(ctx).then(function () {
      return DSM.Voices.select(S.voicePack);
    }).catch(function () { });

    renderHome();
    showView('view-home');

    var want = (location.hash || '').replace('#', '');
    if (want && DSM.Dances.get(want)) openDance(want);

    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () { });
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  return { open: openDance };
})();
