// ============================================================
//  音效 —— 全部用 Web Audio 即時合成，不需要任何音檔
//  ------------------------------------------------------------
//  瀏覽器規定必須先有使用者手勢才能出聲，所以投影頁上有一顆
//  「開啟音效」按鈕，按下時呼叫 unlock()。
// ============================================================

let ctx = null;
let master = null;
let enabled = false;

/** 使用者按下按鈕後呼叫，之後才發得出聲音 */
export async function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") await ctx.resume();
  enabled = ctx.state === "running";
  return enabled;
}

export const isEnabled = () => enabled;

export function setVolume(v) {
  if (master) master.gain.value = Math.max(0, Math.min(1, v));
}

// ---------- 基本積木 ----------

/** 一個帶包封的振盪器音 */
function blip({ freq, dur = 0.12, type = "sine", gain = 0.3, at = 0, glideTo = null }) {
  if (!enabled) return;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const g   = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + dur);

  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** 白噪音爆點，用來做打擊感 */
function noise({ dur = 0.12, gain = 0.2, at = 0, hp = 800 }) {
  if (!enabled) return;
  const t = ctx.currentTime + at;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = "highpass";
  filt.frequency.value = hp;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  src.connect(filt).connect(g).connect(master);
  src.start(t);
}

// ---------- 對外的音效 ----------

/**
 * 最後幾秒的重音。BGM 本身已經有節拍，所以只在剩 10 秒內加尖銳的提示音。
 * @param left 剩餘秒數
 */
export function tick(left) {
  if (!enabled || left > 10) return;
  if (left <= 5) {
    blip({ freq: 1320, dur: 0.085, type: "square", gain: 0.24 });
    noise({ dur: 0.05, gain: 0.1, hp: 2600 });
  } else {
    blip({ freq: 990, dur: 0.07, type: "square", gain: 0.17 });
  }
}

// ============================================================
//  倒數 BGM
//  ------------------------------------------------------------
//  A 小調的四小節循環（Am → Am → F → E），16 分音符的低音固定音型
//  加上大鼓與 hi-hat。速度從 104 BPM 一路推到 168 BPM，
//  低通濾波與音量同時往上開，越接近時間到越緊繃。
//  用「預先排程」的方式送出音符，所以不會被主執行緒卡頓影響節奏。
// ============================================================

const A1 = 55;                                   // 基準音 A1
const semi = n => A1 * Math.pow(2, n / 12);

// 四小節的和弦根音（半音位移）：Am, Am, F, E
const CHORD_ROOTS = [0, 0, 8, 7];
// 一小節 16 個 16 分音符，低音的音型（null = 休止）
const BASS_PATTERN = [0, null, 0, null, 0, null, 12, null, 0, null, 0, null, 7, null, 12, null];
const KICK_STEPS = [0, 6, 10];
const BARS = 4;

const bgm = {
  on: false, step: 0, nextAt: 0, timer: null,
  startedAt: 0, limit: 60, pad: null, padGain: null, padFilter: null, bus: null
};

function bgmTempo() {
  const p = Math.min(1, Math.max(0, (ctx.currentTime - bgm.startedAt) / bgm.limit));
  return 104 + p * 64;                           // 104 → 168 BPM
}

/** 一個 16 分音符 */
function stepDur() { return 60 / bgmTempo() / 4; }

function bassNote(freq, at, dur, gain) {
  const osc = ctx.createOscillator();
  const sub = ctx.createOscillator();
  const lp  = ctx.createBiquadFilter();
  const g   = ctx.createGain();

  osc.type = "sawtooth"; osc.frequency.setValueAtTime(freq, at);
  sub.type = "sine";     sub.frequency.setValueAtTime(freq / 2, at);

  lp.type = "lowpass";
  lp.frequency.setValueAtTime(420, at);
  lp.frequency.exponentialRampToValueAtTime(180, at + dur);
  lp.Q.value = 6;

  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

  osc.connect(lp); sub.connect(lp);
  lp.connect(g).connect(bgm.bus);
  osc.start(at); sub.start(at);
  osc.stop(at + dur + 0.02); sub.stop(at + dur + 0.02);
}

function kick(at, gain) {
  const osc = ctx.createOscillator();
  const g   = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(135, at);
  osc.frequency.exponentialRampToValueAtTime(46, at + 0.11);
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
  osc.connect(g).connect(bgm.bus);
  osc.start(at); osc.stop(at + 0.16);
}

function hat(at, gain) {
  const len = Math.floor(ctx.sampleRate * 0.03);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 7000;
  const g = ctx.createGain(); g.gain.value = gain;
  src.connect(hp).connect(g).connect(bgm.bus);
  src.start(at);
}

/** 四小節結尾的上升噪音，把張力接到下一輪 */
function riser(at, dur) {
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass"; bp.Q.value = 3;
  bp.frequency.setValueAtTime(500, at);
  bp.frequency.exponentialRampToValueAtTime(5200, at + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.055, at + dur * 0.85);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(bp).connect(g).connect(bgm.bus);
  src.start(at); src.stop(at + dur);
}

function scheduleStep(step, at) {
  const bar  = Math.floor(step / 16) % BARS;
  const i    = step % 16;
  const root = CHORD_ROOTS[bar];
  const urgency = Math.min(1, Math.max(0, (ctx.currentTime - bgm.startedAt) / bgm.limit));

  const off = BASS_PATTERN[i];
  if (off !== null) {
    const accent = i === 0 ? 1 : 0.72;
    bassNote(semi(root + off), at, stepDur() * 1.7, (0.10 + urgency * 0.06) * accent);
  }
  if (KICK_STEPS.includes(i)) kick(at, 0.22 + urgency * 0.1);
  if (i % 2 === 1) hat(at, (i % 4 === 3 ? 0.05 : 0.028) + urgency * 0.02);

  // 每四小節的最後一小節放一段上升噪音
  if (bar === BARS - 1 && i === 8) riser(at, stepDur() * 8);

  // 和弦換了就把 pad 移到新的根音
  if (i === 0 && bgm.pad) {
    bgm.pad.forEach((osc, k) => {
      osc.frequency.setTargetAtTime(semi(root + [12, 15, 19, 24][k]), at, 0.05);
    });
  }
}

function bgmTick() {
  if (!bgm.on) return;
  while (bgm.nextAt < ctx.currentTime + 0.15) {
    scheduleStep(bgm.step, Math.max(bgm.nextAt, ctx.currentTime + 0.01));
    bgm.nextAt += stepDur();
    bgm.step = (bgm.step + 1) % (16 * BARS);
  }
}

/** 開放作答時啟動倒數 BGM */
export function startBgm(limitSec = 60) {
  if (!enabled || bgm.on) return;
  const t = ctx.currentTime;

  bgm.bus = ctx.createGain();
  bgm.bus.gain.setValueAtTime(0.0001, t);
  bgm.bus.gain.exponentialRampToValueAtTime(0.9, t + 0.8);
  bgm.bus.connect(master);

  // 持續的和弦鋪底
  bgm.padFilter = ctx.createBiquadFilter();
  bgm.padFilter.type = "lowpass";
  bgm.padFilter.frequency.setValueAtTime(600, t);
  bgm.padFilter.frequency.linearRampToValueAtTime(2400, t + limitSec);
  bgm.padGain = ctx.createGain();
  bgm.padGain.gain.setValueAtTime(0.0001, t);
  bgm.padGain.gain.exponentialRampToValueAtTime(0.035, t + 1.5);
  bgm.padGain.gain.linearRampToValueAtTime(0.062, t + limitSec);
  bgm.padFilter.connect(bgm.padGain).connect(bgm.bus);

  bgm.pad = [12, 15, 19, 24].map(n => {          // A minor add9 的堆疊
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(semi(n), t);
    osc.detune.value = (Math.random() - 0.5) * 12;
    osc.connect(bgm.padFilter);
    osc.start(t);
    return osc;
  });

  bgm.on = true;
  bgm.step = 0;
  bgm.startedAt = t;
  bgm.limit = Math.max(5, limitSec);
  bgm.nextAt = t + 0.06;
  bgmTick();
  bgm.timer = setInterval(bgmTick, 25);
}

export function stopBgm() {
  if (!bgm.on) return;
  bgm.on = false;
  clearInterval(bgm.timer);
  bgm.timer = null;

  if (!enabled) { bgm.pad = null; bgm.bus = null; return; }
  const t = ctx.currentTime;
  bgm.bus.gain.cancelScheduledValues(t);
  bgm.bus.gain.setValueAtTime(bgm.bus.gain.value, t);
  bgm.bus.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  (bgm.pad || []).forEach(osc => osc.stop(t + 0.45));
  bgm.pad = null;
  bgm.bus = null;
}

/** 某一組代表按下確認 —— 明亮的兩音上揚 */
export function confirmed() {
  blip({ freq: 784,  dur: 0.10, type: "sine",     gain: 0.34 });
  blip({ freq: 1175, dur: 0.16, type: "sine",     gain: 0.30, at: 0.085 });
  noise({ dur: 0.06, gain: 0.10, hp: 3000, at: 0.085 });
}

/** 有一組代表就位 —— 比「確認送出」輕，是報到不是定案 */
export function joined() {
  blip({ freq: 587, dur: 0.09, type: "sine", gain: 0.24 });
  blip({ freq: 880, dur: 0.13, type: "sine", gain: 0.20, at: 0.07 });
}

/**
 * 時間到。
 * 刻意不用往下滑音 —— 下墜的音高聽起來像在嘲笑人，改成乾脆的一記撞擊：
 * 低頻衝擊 + 被掐住的金屬鑼聲 + 一記沉的小調和弦收尾。
 */
export function timeUp() {
  stopBgm();
  if (!enabled) return;
  const t = ctx.currentTime;

  // 低頻衝擊，短促、收得乾淨
  const thud = ctx.createOscillator();
  const tg   = ctx.createGain();
  thud.type = "sine";
  thud.frequency.setValueAtTime(98, t);
  thud.frequency.linearRampToValueAtTime(74, t + 0.09);
  tg.gain.setValueAtTime(0.55, t);
  tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  thud.connect(tg).connect(master);
  thud.start(t);
  thud.stop(t + 0.32);

  // 金屬撞擊：非整數倍的泛音疊起來，像鑼被掐住的那一下
  [1245, 1867, 2490, 3320].forEach((f, i) => {
    blip({ freq: f, dur: 0.34 - i * 0.055, type: "triangle", gain: 0.15 - i * 0.028 });
  });
  noise({ dur: 0.13, gain: 0.2, hp: 1500 });

  // A 小調和弦收尾，給「結束了」的重量
  [110, 131, 165].forEach(f =>
    blip({ freq: f, dur: 0.8, type: "triangle", gain: 0.1, at: 0.02 }));
}

/** 公布答案 —— 上揚的和弦 */
export function fanfare() {
  const notes = [523, 659, 784, 1047];
  notes.forEach((f, i) => blip({ freq: f, dur: 0.5, type: "triangle", gain: 0.26, at: i * 0.075 }));
  noise({ dur: 0.45, gain: 0.1, hp: 1800, at: 0.25 });
}

/** 全部結束、公布排行榜 */
export function victory() {
  const notes = [523, 659, 784, 1047, 1319];
  notes.forEach((f, i) => blip({ freq: f, dur: 0.62, type: "triangle", gain: 0.24, at: i * 0.1 }));
}
