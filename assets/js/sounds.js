// ============================================================
//  音效 —— 提示音用 Web Audio 即時合成，作答背景音樂則是 assets/audio 下的音檔
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
  // 先把 BGM 接起來開始緩衝，第一題才不會卡在下載
  if (enabled) ensureBgm();
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
//  作答背景音樂
//  ------------------------------------------------------------
//  播 assets/audio/bgm-quiz.mp3，接到 master 上，setVolume() 一樣管得到。
//  開放作答時淡入，截止時淡出 —— 直接 pause 會「喀」一聲。
//  路徑用 import.meta.url 解析，之後換別頁引用這個模組也不會斷。
// ============================================================

const BGM_URL  = new URL("../audio/bgm-quiz.mp3", import.meta.url).href;
const BGM_GAIN = 0.5;      // 壓在主持人講話之下
const FADE_IN  = 0.8;
const FADE_OUT = 0.5;

const bgm = { on: false, el: null, src: null, gain: null };

/**
 * <audio> 與 MediaElementSource 都只建一次 ——
 * 同一個 <audio> 不能接第二次 createMediaElementSource，會直接丟例外。
 */
function ensureBgm() {
  if (!bgm.el) {
    bgm.el = new Audio(BGM_URL);
    bgm.el.loop = true;    // 題目時間比曲子長就接著繞回去
    bgm.el.preload = "auto";
  }
  if (!bgm.src && ctx) {
    bgm.src  = ctx.createMediaElementSource(bgm.el);
    bgm.gain = ctx.createGain();
    bgm.gain.gain.value = 0.0001;
    bgm.src.connect(bgm.gain).connect(master);
  }
  return bgm.el;
}

/** 開放作答 → 從頭淡入 */
export function startBgm() {
  if (!enabled || bgm.on) return;
  const el = ensureBgm();
  if (!bgm.gain) return;

  bgm.on = true;
  try { el.currentTime = 0; } catch { /* 還沒 seek 得動就算了，照樣播 */ }

  const t = ctx.currentTime;
  bgm.gain.gain.cancelScheduledValues(t);
  bgm.gain.gain.setValueAtTime(0.0001, t);
  bgm.gain.gain.exponentialRampToValueAtTime(BGM_GAIN, t + FADE_IN);
  el.play().catch(() => {});   // 沒解鎖就播不出來，不用吵
}

/** 截止或換階段 → 淡出後才真的停 */
export function stopBgm() {
  if (!bgm.on) return;
  bgm.on = false;
  const el = bgm.el;
  if (!el) return;
  if (!enabled || !bgm.gain) { el.pause(); return; }

  const t = ctx.currentTime;
  bgm.gain.gain.cancelScheduledValues(t);
  bgm.gain.gain.setValueAtTime(Math.max(bgm.gain.gain.value, 0.0001), t);
  bgm.gain.gain.exponentialRampToValueAtTime(0.0001, t + FADE_OUT);
  // 淡出跑完才 pause；期間又開了新的一題就不要停
  setTimeout(() => { if (!bgm.on) el.pause(); }, FADE_OUT * 1000 + 60);
}

/** 某一組代表按下確認 —— 明亮的兩音上揚 */
export function confirmed() {
  blip({ freq: 784,  dur: 0.10, type: "sine",     gain: 0.34 });
  blip({ freq: 1175, dur: 0.16, type: "sine",     gain: 0.30, at: 0.085 });
  noise({ dur: 0.06, gain: 0.10, hp: 3000, at: 0.085 });
}

/** 轉盤每經過一格的「答」聲。轉快的時候會連成一串答答答。 */
export function wheelTick() {
  if (!enabled) return;
  blip({ freq: 1500, dur: 0.035, type: "square", gain: 0.16 });
  noise({ dur: 0.022, gain: 0.09, hp: 4000 });
}

/** 轉盤停下來 */
export function wheelStop() {
  blip({ freq: 660,  dur: 0.14, type: "triangle", gain: 0.3 });
  blip({ freq: 990,  dur: 0.2,  type: "triangle", gain: 0.28, at: 0.1 });
  blip({ freq: 1320, dur: 0.34, type: "triangle", gain: 0.26, at: 0.2 });
  noise({ dur: 0.25, gain: 0.12, hp: 2000, at: 0.2 });
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
