/* 댄스스포츠 10개 종목 데이터
 *
 * MPM = 마디/분 (댄서가 쓰는 단위), BPM = 박/분 (메트로놈 단위)
 *   BPM = MPM x beatsPerBar
 *
 * click / voice 배열의 길이는 항상 beatsPerBar * tpb 이다.
 * tpb(ticks per beat)는 그 종목을 표현하는 데 필요한 최소 해상도.
 *   1 = 박 단위, 2 = 8분음표, 4 = 16분음표
 *
 * 클릭 음색 키
 *   A  마디 첫박 (가장 강함)
 *   M  보조 강박
 *   w  약박
 *   s  분할박 (짧고 작게)
 *   '' 무음
 *
 * 음성 음절 키
 *   '1'~'8', 'cha', 'a', 'and', 'slow', 'quick', '' = 무음
 *   voiceStyles의 첫 번째가 그 종목의 기본 카운트.
 */
window.DSM = window.DSM || {};

DSM.Dances = (function () {
  'use strict';

  var LIST = [
    /* ---------------- 스탠다드 ---------------- */
    {
      id: 'waltz', ko: '왈츠', short: '왈츠', en: 'Waltz', style: 'standard',
      beatsPerBar: 3, tpb: 1,
      mpm: { min: 28, max: 30, def: 29 },
      click: ['A', 'w', 'w'],
      voiceStyles: [
        { id: 'number', name: '원 투 쓰리', seq: ['1', '2', '3'] }
      ]
    },
    {
      id: 'tango', ko: '탱고', short: '탱고', en: 'Tango', style: 'standard',
      beatsPerBar: 4, tpb: 1,
      mpm: { min: 31, max: 33, def: 32 },
      click: ['A', 'w', 'M', 'w'],
      voiceStyles: [
        { id: 'number', name: '원 투 쓰리 포', seq: ['1', '2', '3', '4'] },
        { id: 'sq', name: '슬로우 슬로우 퀵퀵', seq: ['slow', '', 'quick', 'quick'] }
      ]
    },
    {
      id: 'vwaltz', ko: '비엔나 왈츠', short: '비엔나', en: 'Viennese Waltz', style: 'standard',
      beatsPerBar: 3, tpb: 1,
      mpm: { min: 58, max: 60, def: 59 },
      click: ['A', 'w', 'w'],
      voiceStyles: [
        { id: 'number', name: '원 투 쓰리', seq: ['1', '2', '3'] }
      ]
    },
    {
      id: 'foxtrot', ko: '슬로우 폭스트롯', short: '폭스트롯', en: 'Slow Foxtrot', style: 'standard',
      beatsPerBar: 4, tpb: 1,
      mpm: { min: 28, max: 30, def: 29 },
      click: ['A', 'w', 'M', 'w'],
      voiceStyles: [
        /* S = 2박이므로 1~2박에 걸쳐 '슬로우', 3·4박에 '퀵' */
        { id: 'sq', name: '슬로우 퀵퀵', seq: ['slow', '', 'quick', 'quick'] },
        { id: 'number', name: '원 투 쓰리 포', seq: ['1', '2', '3', '4'] }
      ]
    },
    {
      id: 'quickstep', ko: '퀵스텝', short: '퀵스텝', en: 'Quickstep', style: 'standard',
      beatsPerBar: 4, tpb: 1,
      mpm: { min: 50, max: 52, def: 51 },
      click: ['A', 'w', 'M', 'w'],
      voiceStyles: [
        { id: 'sq', name: '슬로우 퀵퀵', seq: ['slow', '', 'quick', 'quick'] },
        { id: 'number', name: '원 투 쓰리 포', seq: ['1', '2', '3', '4'] }
      ]
    },

    /* ---------------- 라틴 ---------------- */
    {
      id: 'samba', ko: '삼바', short: '삼바', en: 'Samba', style: 'latin',
      beatsPerBar: 2, tpb: 4,
      mpm: { min: 50, max: 52, def: 51 },
      /* '아'는 박의 3/4 지점 (3:1 분할) — 정중앙이 아니다 */
      click: ['A', '', '', 's', 'M', '', '', 's'],
      voiceStyles: [
        { id: 'number', name: '원 아 투 아', seq: ['1', '', '', 'a', '2', '', '', 'a'] }
      ]
    },
    {
      id: 'chacha', ko: '차차차', short: '차차차', en: 'Cha Cha Cha', style: 'latin',
      beatsPerBar: 4, tpb: 2,
      mpm: { min: 30, max: 32, def: 31 },
      click: ['A', '', 'w', '', 'M', '', 'w', 's'],
      voiceStyles: [
        { id: 'number', name: '원 투 쓰리 차 차', seq: ['1', '', '2', '', '3', '', 'cha', 'cha'] },
        /* 투·쓰리 다음 4&1 에 차차차 — 선생님에 따라 이렇게 세기도 한다 */
        { id: 'alt', name: '투 쓰리 차차차', seq: ['cha', '', '2', '', '3', '', 'cha', 'cha'] }
      ]
    },
    {
      id: 'rumba', ko: '룸바', short: '룸바', en: 'Rumba', style: 'latin',
      beatsPerBar: 4, tpb: 1,
      /* 스텝이 2박에서 시작하므로 2박을 보조 강박으로 */
      mpm: { min: 25, max: 27, def: 26 },
      click: ['A', 'M', 'w', 'w'],
      voiceStyles: [
        { id: 'number', name: '원 투 쓰리 포', seq: ['1', '2', '3', '4'] }
      ]
    },
    {
      id: 'paso', ko: '파소도블레', short: '파소', en: 'Paso Doble', style: 'latin',
      beatsPerBar: 2, tpb: 1,
      mpm: { min: 60, max: 62, def: 61 },
      click: ['A', 'w'],
      voiceStyles: [
        { id: 'number', name: '원 투', seq: ['1', '2'] }
      ]
    },
    {
      id: 'jive', ko: '자이브', short: '자이브', en: 'Jive', style: 'latin',
      beatsPerBar: 4, tpb: 4,
      mpm: { min: 42, max: 44, def: 43 },
      /* 샤세 3a4 — '아'는 3박·4박의 3/4 지점 */
      click: ['A', '', '', '', 'w', '', '', '', 'M', '', '', 's', 'w', '', '', 's'],
      voiceStyles: [
        {
          id: 'number', name: '원 투 쓰리아포아',
          seq: ['1', '', '', '', '2', '', '', '', '3', '', '', 'a', '4', '', '', 'a']
        }
      ]
    }
  ];

  var BY_ID = {};
  LIST.forEach(function (d) {
    d.slotsPerBar = d.beatsPerBar * d.tpb;
    d.bpm = { min: d.mpm.min * d.beatsPerBar, max: d.mpm.max * d.beatsPerBar, def: d.mpm.def * d.beatsPerBar };
    BY_ID[d.id] = d;
  });

  /* 예비박 길이를 마디 경계에 맞춰 해결한다.
   * 8박을 그대로 쓰면 3박자 종목에서 본박이 마디 3박째에 시작해 다운비트가 어긋난다.
   * 그래서 항상 beatsPerBar의 배수로 내림한다. (3/4 에서 8 -> 6박 = 2마디) */
  function resolveCountIn(dance, mode) {
    var per = dance.beatsPerBar;
    if (mode === 'off') return 0;
    if (mode === 'bars2') return per * 2;
    var want = (mode === '4') ? 4 : 8;
    var bars = Math.floor(want / per);
    if (bars < 1) bars = 1;
    return bars * per;
  }

  /* 심플 모드: 패턴을 무시하고 마디 첫박만 강조 */
  function simpleClick(dance) {
    var out = [];
    for (var i = 0; i < dance.slotsPerBar; i++) {
      out.push(i === 0 ? 'A' : (i % dance.tpb === 0 ? 'w' : ''));
    }
    return out;
  }

  function voiceStyle(dance, styleId) {
    for (var i = 0; i < dance.voiceStyles.length; i++) {
      if (dance.voiceStyles[i].id === styleId) return dance.voiceStyles[i];
    }
    return dance.voiceStyles[0];
  }

  /* 스케줄러와 검증이 같은 식을 쓰도록 여기 한 곳에만 둔다 */
  function tickSeconds(dance, bpm) { return 60 / bpm / dance.tpb; }
  function barSeconds(dance, bpm) { return 60 / bpm * dance.beatsPerBar; }

  return {
    list: LIST,
    get: function (id) { return BY_ID[id]; },
    tickSeconds: tickSeconds,
    barSeconds: barSeconds,
    resolveCountIn: resolveCountIn,
    simpleClick: simpleClick,
    voiceStyle: voiceStyle,
    COUNT_IN_MODES: [
      { id: '8', name: '8박' },
      { id: '4', name: '4박' },
      { id: 'bars2', name: '2마디' },
      { id: 'off', name: '끄기' }
    ]
  };
})();
