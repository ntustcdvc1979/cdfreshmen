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
 * 倒數的滴答。剩下越少秒，音越高越急。
 * @param left 剩餘秒數
 */
export function tick(left) {
  if (!enabled) return;
  if (left <= 5) {
    blip({ freq: 1180, dur: 0.09, type: "square", gain: 0.26 });
    noise({ dur: 0.05, gain: 0.12, hp: 2200 });
  } else if (left <= 10) {
    blip({ freq: 900, dur: 0.075, type: "square", gain: 0.2 });
  } else {
    blip({ freq: 700, dur: 0.055, type: "triangle", gain: 0.13 });
  }
}

/** 緊張的低音鋪底，開放作答時啟動 */
let tensionNodes = null;
export function startTension(limitSec = 60) {
  if (!enabled || tensionNodes) return;
  const t = ctx.currentTime;

  const osc = ctx.createOscillator();
  const sub = ctx.createOscillator();
  const g   = ctx.createGain();
  const lp  = ctx.createBiquadFilter();

  osc.type = "sawtooth";
  sub.type = "sine";
  osc.frequency.setValueAtTime(55, t);
  sub.frequency.setValueAtTime(41, t);
  // 隨時間慢慢升高，越接近時間到越焦躁
  osc.frequency.linearRampToValueAtTime(96, t + limitSec);
  sub.frequency.linearRampToValueAtTime(62, t + limitSec);

  lp.type = "lowpass";
  lp.frequency.setValueAtTime(320, t);
  lp.frequency.linearRampToValueAtTime(900, t + limitSec);

  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.085, t + 1.2);
  g.gain.linearRampToValueAtTime(0.16, t + limitSec);

  osc.connect(lp);
  sub.connect(lp);
  lp.connect(g).connect(master);
  osc.start(t); sub.start(t);
  tensionNodes = { osc, sub, g };
}

export function stopTension() {
  if (!tensionNodes) return;
  const { osc, sub, g } = tensionNodes;
  tensionNodes = null;
  if (!enabled) return;
  const t = ctx.currentTime;
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(g.gain.value, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
  osc.stop(t + 0.4);
  sub.stop(t + 0.4);
}

/** 某一組代表按下確認 —— 明亮的兩音上揚 */
export function confirmed() {
  blip({ freq: 784,  dur: 0.10, type: "sine",     gain: 0.34 });
  blip({ freq: 1175, dur: 0.16, type: "sine",     gain: 0.30, at: 0.085 });
  noise({ dur: 0.06, gain: 0.10, hp: 3000, at: 0.085 });
}

/** 時間到 */
export function timeUp() {
  stopTension();
  blip({ freq: 220, dur: 0.5, type: "sawtooth", gain: 0.3, glideTo: 110 });
  noise({ dur: 0.3, gain: 0.16, hp: 400 });
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
