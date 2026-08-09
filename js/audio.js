/* 오디오 엔진
 *
 * 타이밍이 이 앱의 전부다.
 * setInterval 로 직접 소리를 내면 브라우저 타이머 지터 때문에 박이 흔들린다.
 * 그래서 25ms 마다 깨어나 "앞으로 120ms 안에 울릴 것"을 AudioContext 시계 기준
 * 절대시각으로 미리 예약한다(lookahead 스케줄러). 실제 발음은 오디오 하드웨어
 * 클럭이 담당하므로 UI가 버벅여도 박은 안 흔들린다.
 *
 * 음성도 AudioBufferSourceNode.start(정확한시각) 으로 예약하므로 밀리초 단위로 맞는다.
 * (브라우저 TTS 를 안 쓰는 이유 — 발음 시작 시각을 예약할 수 없어 빠른 템포에서 밀린다)
 */
window.DSM = window.DSM || {};

DSM.Audio = (function () {
  'use strict';

  var LOOKAHEAD_MS = 25;     // 스케줄러가 깨어나는 주기
  var SCHEDULE_AHEAD = 0.12; // 미리 예약해 두는 시간(초)
  var RESUME_DELAY = 0.18;   // 첫 소리까지의 여유. 음절 선행 보정(최대 120ms)보다 커야 한다

  var ctx = null;
  var master = null, busClick = null, busVoice = null, busMusic = null;
  var noiseBuf = null;
  var timer = null;

  var vol = { click: 0.9, voice: 0.9, music: 0.8, master: 1 };

  var st = {
    status: 'stopped',   // stopped | countin | playing | paused
    dance: null,
    bpm: 120,
    tpb: 1,
    slotsPerBar: 4,
    clickPat: [],
    voicePat: [],
    voiceGap: [],        // 각 슬롯에서 다음 음성까지의 tick 수
    countInTicks: 0,
    countInBeats: 0,
    phase: 'countin',
    tick: 0,
    bar: 0,
    nextTime: 0,
    theme: 'click',
    phraseAccent: true,
    resumeRemainder: 0
  };

  /* position      = 다음에 재생을 이어갈 곡 안의 위치(초)
   * startPosition = 재생을 시작할 위치. align.offset(첫 다운비트)이 기본이며,
   *                 사용자가 시작 마디를 바꾸면 마디 경계로 스냅해 여기에 들어간다. */
  var music = {
    buffer: null, align: null, src: null,
    startedAt: 0, offsetAtStart: 0,
    position: 0, startPosition: 0, loop: false, onEnd: null
  };

  var visualQ = [];
  var onTick = null;
  var rafId = null;

  /* 연습 시간 누적: 재생 중인 시간만 센다 */
  var elapsedAccum = 0;
  var runSince = null;

  /* ---------------- 클릭음 ---------------- */
  /* 기계식 메트로놈의 "딱" 소리 = 짧은 노이즈 버스트를 밴드패스로 좁힌 것 +
   * 몸통을 만들어 주는 짧은 사인 톤. 샘플 파일 없이 합성한다. */
  var THEMES = {
    click: {
      noise: true,
      A: { f: 2400, q: 3.0, g: 1.00, d: 0.038, tone: 0.35 },
      M: { f: 1800, q: 3.0, g: 0.72, d: 0.032, tone: 0.30 },
      w: { f: 1200, q: 3.0, g: 0.50, d: 0.028, tone: 0.25 },
      s: { f: 3000, q: 6.0, g: 0.30, d: 0.018, tone: 0.15 },
      C: { f: 900, q: 1.5, g: 0.62, d: 0.048, tone: 0.10 },
      P: { f: 2700, q: 3.0, g: 1.00, d: 0.050, tone: 0.55 }
    },
    wood: {
      noise: true,
      A: { f: 1000, q: 1.2, g: 1.00, d: 0.060, tone: 0.70 },
      M: { f: 820, q: 1.2, g: 0.72, d: 0.052, tone: 0.62 },
      w: { f: 640, q: 1.2, g: 0.50, d: 0.045, tone: 0.55 },
      s: { f: 1400, q: 2.0, g: 0.28, d: 0.024, tone: 0.40 },
      C: { f: 460, q: 1.0, g: 0.60, d: 0.070, tone: 0.35 },
      P: { f: 1150, q: 1.2, g: 1.00, d: 0.070, tone: 0.80 }
    },
    beep: {
      noise: false,
      A: { f: 1760, q: 1, g: 0.85, d: 0.045, tone: 1 },
      M: { f: 1320, q: 1, g: 0.62, d: 0.040, tone: 1 },
      w: { f: 880, q: 1, g: 0.45, d: 0.035, tone: 1 },
      s: { f: 2200, q: 1, g: 0.26, d: 0.020, tone: 1 },
      C: { f: 587, q: 1, g: 0.55, d: 0.055, tone: 1 },
      P: { f: 2093, q: 1, g: 0.85, d: 0.055, tone: 1 }
    }
  };

  function ensureCtx() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();

    master = ctx.createGain(); master.gain.value = vol.master;
    busClick = ctx.createGain(); busClick.gain.value = vol.click;
    busVoice = ctx.createGain(); busVoice.gain.value = vol.voice;
    busMusic = ctx.createGain(); busMusic.gain.value = vol.music;
    busClick.connect(master); busVoice.connect(master); busMusic.connect(master);
    master.connect(ctx.destination);

    noiseBuf = makeNoise(ctx);

    return ctx;
  }

  /* 노이즈는 고정 시드로 만든다. 백색소음이라 소리는 매번 같게 들리지만,
   * 렌더 결과가 재현되므로 진단 측정값이 실행마다 흔들리지 않는다. */
  function makeNoise(actx) {
    var len = Math.floor(actx.sampleRate * 0.25);
    var b = actx.createBuffer(1, len, actx.sampleRate);
    var d = b.getChannelData(0);
    var s = 0x2f6e2b1;                       // 고정 시드
    for (var i = 0; i < len; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;  // LCG
      d[i] = (s / 0x80000000) - 1;
    }
    return b;
  }

  /* 실시간 재생과 오프라인 렌더가 같은 합성 코드를 쓰도록 컨텍스트를 인자로 받는다.
   * 덕분에 진단 페이지가 "실제로 나는 소리"를 그대로 렌더해 검사할 수 있다. */
  function synthClick(actx, dest, themeName, kind, time, noise) {
    var theme = THEMES[themeName] || THEMES.click;
    var c = theme[kind];
    if (!c) return;

    if (theme.noise) {
      var src = actx.createBufferSource();
      src.buffer = noise;
      var bp = actx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = c.f; bp.Q.value = c.q;
      var g = actx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.linearRampToValueAtTime(c.g, time + 0.0012);
      g.gain.exponentialRampToValueAtTime(0.0001, time + c.d);
      src.connect(bp); bp.connect(g); g.connect(dest);
      src.start(time); src.stop(time + c.d + 0.02);
    }

    if (c.tone > 0) {
      var o = actx.createOscillator();
      o.type = (themeName === 'beep') ? 'square' : 'sine';
      o.frequency.setValueAtTime(c.f, time);
      var og = actx.createGain();
      og.gain.setValueAtTime(0.0001, time);
      og.gain.linearRampToValueAtTime(c.g * c.tone, time + 0.0012);
      og.gain.exponentialRampToValueAtTime(0.0001, time + c.d * 0.85);
      o.connect(og); og.connect(dest);
      o.start(time); o.stop(time + c.d + 0.02);
    }
  }

  function playClick(kind, time) {
    synthClick(ctx, busClick, st.theme, kind, time, noiseBuf);
  }

  function playVoice(key, time) {
    if (!DSM.Voices) return 0;
    var buf = DSM.Voices.getBuffer(key);
    if (!buf) return 0;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(busVoice);
    // 앞이 무딘 음절(ㅆ·ㅌ 등)은 그만큼 앞당겨야 박에 맞게 들린다
    src.start(Math.max(ctx.currentTime, time - DSM.Voices.leadOf(buf)));
    return buf.duration;
  }

  function voiceDuration(key) {
    if (!DSM.Voices) return 0;
    var buf = DSM.Voices.getBuffer(key);
    return buf ? buf.duration : 0;
  }

  /* ---------------- 패턴 준비 ---------------- */

  /* 각 슬롯에서 "다음 음성이 나올 때까지 몇 tick 남았는지" 미리 계산.
   * 빠른 템포에서 음절이 겹칠 때 분할박 음성을 자동으로 생략하는 데 쓴다. */
  function buildVoiceGap(pat) {
    var n = pat.length;
    var gap = new Array(n).fill(n);
    for (var i = 0; i < n; i++) {
      if (!pat[i]) continue;
      for (var k = 1; k <= n; k++) {
        if (pat[(i + k) % n]) { gap[i] = k; break; }
      }
    }
    return gap;
  }

  function buildPatterns(dance, opts) {
    var click = opts.simple ? DSM.Dances.simpleClick(dance) : dance.click.slice();
    var voice = (opts.voiceStyleId === 'off')
      ? new Array(dance.slotsPerBar).fill('')
      : DSM.Dances.voiceStyle(dance, opts.voiceStyleId).seq.slice();
    return { click: click, voice: voice, gap: buildVoiceGap(voice) };
  }

  function applyPatterns(opts) {
    var p = buildPatterns(st.dance, opts);
    st.clickPat = p.click;
    st.voicePat = p.voice;
    st.voiceGap = p.gap;
  }

  /* 한 이벤트에서 어떤 클릭 음색과 음절이 나야 하는지.
   * 실시간 스케줄러와 오프라인 렌더가 이 한 곳만 본다 — 둘이 갈라지지 않게. */
  function slotSound(pat, ev, phraseAccent) {
    if (ev.phase === 'countin') {
      return ev.beat >= 0
        ? { click: 'C', voice: String(ev.beat + 1) }
        : { click: '', voice: '' };
    }
    var c = pat.click[ev.slot] || '';
    if (phraseAccent && ev.slot === 0 && (ev.bar % 8 === 0) && c === 'A') c = 'P';
    return { click: c, voice: pat.voice[ev.slot] || '' };
  }

  function secondsPerTick() { return DSM.Dances.tickSeconds(st.dance, st.bpm); }

  /* ---------------- 스케줄러 ---------------- */

  function scheduleTick(time) {
    var spt = secondsPerTick();
    var onBeat = (st.tick % st.tpb) === 0;
    var ev = {
      phase: st.phase,
      slot: st.phase === 'main' ? (st.tick % st.slotsPerBar) : -1,
      beat: onBeat ? (st.tick / st.tpb) : -1,
      bar: st.bar
    };
    var snd = slotSound({ click: st.clickPat, voice: st.voicePat }, ev, st.phraseAccent);

    if (snd.click) playClick(snd.click, time);

    if (snd.voice && vol.voice > 0) {
      if (ev.phase === 'countin') {
        playVoice(snd.voice, time);
      } else {
        // 분할박 음절이 다음 음절을 덮어버릴 만큼 빠르면 생략한다.
        // 박 위의 음절은 절대 생략하지 않는다.
        var dur = voiceDuration(snd.voice);
        var gapSec = st.voiceGap[ev.slot] * spt;
        if (!(!onBeat && dur > gapSec)) playVoice(snd.voice, time);
      }
    }

    if (ev.phase === 'countin') {
      if (ev.beat >= 0) {
        visualQ.push({
          t: time, phase: 'countin',
          remaining: st.countInBeats - ev.beat,
          beat: ev.beat, accent: false
        });
      }
      return;
    }

    visualQ.push({
      t: time, phase: 'main',
      slot: ev.slot,
      beat: Math.floor(ev.slot / st.tpb),
      onBeat: onBeat,
      bar: st.bar,
      phrase: st.bar % 8,
      accent: ev.slot === 0
    });
  }

  /* 위치 진행만 떼어낸 순수 함수.
   * 예비박에서 본박으로 넘어가는 지점과 마디 카운트가 가장 틀리기 쉬운 곳이라,
   * 스케줄러와 자가진단(plan)이 반드시 같은 코드를 쓰게 한다. */
  function stepPosition(p, slotsPerBar, countInTicks) {
    var n = { phase: p.phase, tick: p.tick + 1, bar: p.bar };
    if (p.phase === 'countin') {
      if (n.tick >= countInTicks) { n.phase = 'main'; n.tick = 0; n.bar = 0; }
    } else if (n.tick % slotsPerBar === 0) {
      n.bar = p.bar + 1;
    }
    return n;
  }

  function advance() {
    st.nextTime += secondsPerTick();
    var was = st.phase;
    var n = stepPosition({ phase: st.phase, tick: st.tick, bar: st.bar }, st.slotsPerBar, st.countInTicks);
    st.phase = n.phase; st.tick = n.tick; st.bar = n.bar;
    if (was === 'countin' && n.phase === 'main') startMusic(st.nextTime);
  }

  /* 소리 없이 타임라인만 만들어 본다 — 검증용. AudioContext 가 필요 없다. */
  function plan(dance, bpm, opts, seconds) {
    var ci = DSM.Dances.resolveCountIn(dance, (opts && opts.countInMode) || '8') * dance.tpb;
    var spt = DSM.Dances.tickSeconds(dance, bpm);
    var p = { phase: ci > 0 ? 'countin' : 'main', tick: 0, bar: 0 };
    var t = 0, out = [];
    while (t <= seconds + 1e-9) {
      out.push({
        t: t, phase: p.phase, bar: p.bar,
        slot: p.phase === 'main' ? (p.tick % dance.slotsPerBar) : -1,
        beat: (p.tick % dance.tpb === 0) ? (p.tick / dance.tpb) : -1
      });
      p = stepPosition(p, dance.slotsPerBar, ci);
      t += spt;
    }
    return out;
  }

  function scheduler() {
    if (st.status !== 'countin' && st.status !== 'playing') return;
    var horizon = ctx.currentTime + SCHEDULE_AHEAD;
    while (st.nextTime < horizon) {
      scheduleTick(st.nextTime);
      advance();
      if (st.phase === 'main' && st.status === 'countin') st.status = 'playing';
    }
  }

  /* 실제로 나는 소리를 그대로 오프라인 렌더한다. 진단 페이지가 렌더된 PCM에서
   * 클릭 위치를 직접 재서 "귀로 듣는 것과 같은 경로"를 검증할 수 있게 하려는 것.
   * 재생 시각·음색·패턴 선택 로직을 모두 실시간 경로와 공유한다. */
  function renderOffline(dance, bpm, opts, seconds, voiceBuffers) {
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return Promise.reject(new Error('OfflineAudioContext 미지원'));

    var rate = 44100;
    var oc = new OAC(1, Math.max(1, Math.ceil(seconds * rate)), rate);
    var noise = makeNoise(oc);
    var bus = oc.createGain();
    bus.gain.value = 1;
    bus.connect(oc.destination);

    var pat = buildPatterns(dance, opts);
    var theme = opts.theme || 'click';
    var phrase = opts.phraseAccent !== false;
    var wantClicks = opts.renderClicks !== false;
    var wantVoices = opts.renderVoices !== false && !!voiceBuffers;

    plan(dance, bpm, opts, seconds).forEach(function (ev) {
      if (ev.t >= seconds) return;
      var snd = slotSound(pat, ev, phrase);
      if (wantClicks && snd.click) synthClick(oc, bus, theme, snd.click, ev.t, noise);
      if (wantVoices && snd.voice && voiceBuffers[snd.voice]) {
        var vb = voiceBuffers[snd.voice];
        var s = oc.createBufferSource();
        s.buffer = vb;
        s.connect(bus);
        s.start(Math.max(0, ev.t - DSM.Voices.leadOf(vb)));   // 재생 경로와 동일한 보정
      }
    });

    var p = oc.startRendering();
    if (p && p.then) return p;
    return new Promise(function (resolve) {          // 구형 Safari 콜백 형태
      oc.oncomplete = function (e) { resolve(e.renderedBuffer); };
    });
  }

  /* ---------------- 화면 동기화 ---------------- */

  function pump() {
    rafId = requestAnimationFrame(pump);
    if (!ctx) return;
    var now = ctx.currentTime;
    while (visualQ.length && visualQ[0].t <= now) {
      var ev = visualQ.shift();
      if (onTick) onTick(ev);
    }
  }

  /* ---------------- 음원 ---------------- */

  function startMusic(atTime) {
    if (!music.buffer) return;
    stopMusicSource();
    var src = ctx.createBufferSource();
    src.buffer = music.buffer;
    src.loop = music.loop;
    if (music.loop && music.align) {
      // 반복할 때도 다운비트를 유지하려면 첫 다운비트로 되돌아가야 한다
      src.loopStart = music.startPosition;
      src.loopEnd = music.buffer.duration;
    }
    src.connect(busMusic);
    var offset = music.position;
    if (offset >= music.buffer.duration) offset = music.startPosition;
    src.onended = function () {
      if (music.src === src && !music.loop && st.status === 'playing' && music.onEnd) music.onEnd();
    };
    src.start(atTime, offset);
    music.src = src;
    music.startedAt = atTime;
    music.offsetAtStart = offset;
  }

  function stopMusicSource() {
    if (music.src) {
      music.src.onended = null;
      try { music.src.stop(); } catch (e) { /* 이미 끝난 소스 */ }
      music.src.disconnect();
      music.src = null;
    }
  }

  function captureMusicPosition() {
    if (!music.buffer || !music.src) return;
    var elapsed = ctx.currentTime - music.startedAt;
    if (elapsed < 0) elapsed = 0;
    music.position = music.offsetAtStart + elapsed;
    if (music.position > music.buffer.duration) music.position = music.buffer.duration;
  }

  /* 정렬 화면에서 곡을 들으며 탭할 때 쓰는 별도 재생 경로.
   * 메트로놈 그리드와 무관하게 돌아가므로 본 재생과 섞이지 않는다. */
  var pv = { src: null, buffer: null, startedAt: 0, offset: 0 };

  function previewMusicStart(buffer, from) {
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    previewMusicStop();
    var src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(busMusic);
    var off = Math.max(0, Math.min(buffer.duration - 0.05, from || 0));
    src.start(ctx.currentTime + 0.02, off);
    pv.src = src; pv.buffer = buffer;
    pv.startedAt = ctx.currentTime + 0.02;
    pv.offset = off;
  }

  function previewMusicStop() {
    if (pv.src) {
      pv.src.onended = null;
      try { pv.src.stop(); } catch (e) { /* 이미 끝남 */ }
      pv.src.disconnect();
      pv.src = null;
    }
  }

  function previewMusicPos() {
    if (!pv.src || !ctx) return 0;
    var t = ctx.currentTime - pv.startedAt;
    if (t < 0) t = 0;
    return pv.offset + t;
  }

  function previewMusicPlaying() { return !!pv.src; }

  /* ---------------- 시간 누적 ---------------- */

  function markRun() { runSince = ctx.currentTime; }
  function markStop() {
    if (runSince !== null) { elapsedAccum += ctx.currentTime - runSince; runSince = null; }
  }

  /* ---------------- 공개 API ---------------- */

  function start(dance, bpm, opts) {
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();

    stop(true);

    st.dance = dance;
    st.tpb = dance.tpb;
    st.slotsPerBar = dance.slotsPerBar;
    st.theme = opts.theme || 'click';
    st.phraseAccent = opts.phraseAccent !== false;
    st.bpm = music.buffer && music.align ? music.align.bpm : bpm;

    applyPatterns(opts);

    st.countInBeats = DSM.Dances.resolveCountIn(dance, opts.countInMode);
    st.countInTicks = st.countInBeats * st.tpb;
    st.phase = st.countInTicks > 0 ? 'countin' : 'main';
    st.tick = 0;
    st.bar = 0;
    st.nextTime = ctx.currentTime + RESUME_DELAY;
    st.status = st.phase === 'countin' ? 'countin' : 'playing';

    music.position = music.startPosition;
    if (st.phase === 'main') startMusic(st.nextTime);

    visualQ.length = 0;
    markRun();
    if (timer) clearInterval(timer);
    timer = setInterval(scheduler, LOOKAHEAD_MS);
    scheduler();
    if (!rafId) pump();
  }

  function pause() {
    if (st.status !== 'playing' && st.status !== 'countin') return;
    markStop();
    // 다음 tick 까지 남은 시간을 기억해 두면 재개할 때 그리드가 그대로 이어진다.
    st.resumeRemainder = Math.max(0, st.nextTime - ctx.currentTime);
    captureMusicPosition();
    stopMusicSource();
    clearInterval(timer); timer = null;
    visualQ.length = 0;
    st.status = 'paused';
  }

  function resume() {
    if (st.status !== 'paused') return;
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    var base = ctx.currentTime + RESUME_DELAY;
    st.nextTime = base + st.resumeRemainder;
    if (st.phase === 'main' && music.buffer) startMusic(base);
    st.status = st.phase === 'countin' ? 'countin' : 'playing';
    markRun();
    timer = setInterval(scheduler, LOOKAHEAD_MS);
    scheduler();
  }

  function stop(silent) {
    if (ctx) markStop();
    if (timer) { clearInterval(timer); timer = null; }
    stopMusicSource();
    music.position = music.startPosition;
    visualQ.length = 0;
    st.status = 'stopped';
    st.phase = 'countin';
    st.tick = 0;
    st.bar = 0;
    st.resumeRemainder = 0;
    if (!silent && onTick) onTick({ phase: 'stopped' });
  }

  function setBpm(bpm) {
    // 음원에 맞춰 재생 중일 때는 곡 템포에 잠긴다.
    if (music.buffer && music.align) return;
    st.bpm = bpm;
  }

  function setVolume(bus, v) {
    vol[bus] = v;
    if (!ctx) return;
    var node = bus === 'click' ? busClick : bus === 'voice' ? busVoice : bus === 'music' ? busMusic : master;
    node.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
  }

  function getVolume(bus) { return vol[bus]; }

  function setOptions(opts) {
    if (!st.dance) return;
    if (opts.theme) st.theme = opts.theme;
    if (opts.phraseAccent !== undefined) st.phraseAccent = opts.phraseAccent;
    applyPatterns(opts);
  }

  function attachMusic(buffer, align) {
    music.buffer = buffer;
    music.align = align;
    music.startPosition = align ? align.offset : 0;
    music.position = music.startPosition;
    if (align) st.bpm = align.bpm;
  }

  function detachMusic() {
    stopMusicSource();
    music.buffer = null;
    music.align = null;
    music.startPosition = 0;
    music.position = 0;
  }

  /* 재생을 시작할 마디를 고른다. 항상 마디 경계(다운비트)로 스냅한다. */
  function setStartBar(barIndex, beatsPerBar) {
    if (!music.buffer || !music.align) return 0;
    var barLen = 60 / music.align.bpm * beatsPerBar;
    var pos = music.align.offset + barIndex * barLen;
    if (pos < 0) pos = music.align.offset;
    if (pos > music.buffer.duration) pos = music.align.offset;
    music.startPosition = pos;
    if (st.status === 'stopped') music.position = pos;
    return pos;
  }

  function musicBarCount(beatsPerBar) {
    if (!music.buffer || !music.align) return 0;
    var barLen = 60 / music.align.bpm * beatsPerBar;
    return Math.max(1, Math.floor((music.buffer.duration - music.align.offset) / barLen));
  }

  /* 정렬값을 재생 중에도 즉시 반영 (미세조정 슬라이더용) */
  function updateAlign(align, beatsPerBar) {
    music.align = align;
    st.bpm = align.bpm;
    var barLen = 60 / align.bpm * beatsPerBar;
    var bars = Math.round((music.startPosition - align.offset) / barLen);
    if (!isFinite(bars) || bars < 0) bars = 0;
    music.startPosition = align.offset + bars * barLen;
  }

  function musicPosition() {
    if (!music.buffer) return 0;
    if (music.src && (st.status === 'playing')) {
      var elapsed = ctx.currentTime - music.startedAt;
      return Math.max(0, Math.min(music.buffer.duration, music.offsetAtStart + elapsed));
    }
    return music.position;
  }

  /* 마지막 호출 이후 실제로 재생된 시간(초). 연습 기록 누적에 쓴다. */
  function consumeElapsed() {
    var v = elapsedAccum;
    elapsedAccum = 0;
    if (runSince !== null && ctx) {
      var now = ctx.currentTime;
      v += now - runSince;
      runSince = now;
    }
    return v;
  }

  /* 미리듣기 — 설정에서 음색/목소리를 확인할 때 */
  function preview(kind) {
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    playClick(kind, ctx.currentTime + 0.02);
  }

  function previewVoice(key) {
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    playVoice(key, ctx.currentTime + 0.02);
  }

  function context() { return ctx; }

  function status() { return st.status; }

  return {
    init: ensureCtx,
    context: context,
    start: start,
    pause: pause,
    resume: resume,
    stop: stop,
    status: status,
    setBpm: setBpm,
    setVolume: setVolume,
    getVolume: getVolume,
    setOptions: setOptions,
    attachMusic: attachMusic,
    detachMusic: detachMusic,
    updateAlign: updateAlign,
    setStartBar: setStartBar,
    musicBarCount: musicBarCount,
    musicPosition: musicPosition,
    musicDuration: function () { return music.buffer ? music.buffer.duration : 0; },
    hasMusic: function () { return !!music.buffer; },
    setMusicLoop: function (v) { music.loop = !!v; if (music.src) music.src.loop = !!v; },
    onMusicEnd: function (fn) { music.onEnd = fn; },
    consumeElapsed: consumeElapsed,
    preview: preview,
    previewVoice: previewVoice,
    previewMusicStart: previewMusicStart,
    previewMusicStop: previewMusicStop,
    previewMusicPos: previewMusicPos,
    previewMusicPlaying: previewMusicPlaying,
    onTick: function (fn) { onTick = fn; if (!rafId) pump(); },
    plan: plan,
    renderOffline: renderOffline,
    buildPatterns: buildPatterns,
    slotSound: slotSound,
    THEMES: THEMES
  };
})();
