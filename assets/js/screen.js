// ============================================================
//  投影統計頁 —— 主持人切到瀏覽器全螢幕給觀眾看
//  需要主持人身分（原始作答只有 /admins 名單讀得到）。
//  在同一個瀏覽器開過 host.html 登入後，這頁會自動沿用登入狀態。
//
//  鍵盤：→ / ← 翻頁，空白鍵在最終畫面依序公布名次。
// ============================================================

import {
  db, auth, ref, onValue, onAuthStateChanged,
  PATH, PHASE, LISTS, LETTERS, DEFAULT_LIMIT_SEC, CATEGORIES,
  categoryOf, questionsOf, tallyAllMembers, secondsLeft, isHost, ptsOf,
  gridColumns, buildScoreboard, categoryMatrix, groupBestCategories, columnWinners,
  $, show, escapeHtml, toSortedList
} from "./common.js";

import * as snd from "./sounds.js";

let groups = {}, questions = {}, keys = {}, allResp = {}, repAns = {}, reps = {}, state = {}, board = null, intro = {}, doubles = {};
let ready = false, timeOffset = 0;

const stage = $("#stage");
const body  = $("#s-body");
const badge = $("#s-badge");
const foot  = $("#s-phase");
const tip   = $("#s-tip");

// 每 N 題插一頁戰況（最後一題不插，因為接著就是完整排行榜）
const STANDINGS_EVERY = 5;
const STANDINGS_TOP   = 5;
const PODIUM_TOP      = 3;

let introPage  = 0;   // 開場：0 六大主題 / 1 規則 / 2 QR + 代表就位
let revealPage = 0;   // 公布：答案與說明 →（補充大圖）→（目前戰況）→ 全場分布
let podiumStep = 0;   // 排行榜：0 還沒開始 → 3 全部揭曉 → 4 類別分析

// ------------------------------------------------------------
//  音效解鎖
// ------------------------------------------------------------
show($("#sound-gate"), true);
$("#btn-sound").addEventListener("click", async () => {
  await snd.unlock();
  show($("#sound-gate"), false);
});
$("#btn-nosound").addEventListener("click", e => {
  e.preventDefault();
  show($("#sound-gate"), false);
});

// ------------------------------------------------------------
//  登入與資料
// ------------------------------------------------------------
onAuthStateChanged(auth, async user => {
  const ok = await isHost(user);
  if (!ok) {
    body.innerHTML = `<div class="card center stack" style="max-width:60vw; margin:0 auto;">
      <h2 class="title-gold" style="font-size:4.4vh; margin:0;">尚未登入</h2>
      <p class="hint" style="font-size:2.4vh;">請先在同一個瀏覽器開啟
        <a href="host.html" style="color:var(--gold-lt)">主持人控制台</a> 登入，再回到這一頁。</p>
    </div>`;
    return;
  }
  if (ready) return;
  ready = true;
  onValue(ref(db, "/.info/serverTimeOffset"), s => { timeOffset = s.val() || 0; });
  onValue(ref(db, PATH.groups),      s => { groups    = s.val() || {}; paint(); });
  onValue(ref(db, PATH.intro),       s => { intro     = s.val() || {}; paint(); });
  onValue(ref(db, PATH.questions),   s => { questions = s.val() || {}; paint(); });
  onValue(ref(db, PATH.answerKey),   s => { keys      = s.val() || {}; paint(); });
  onValue(ref(db, PATH.responses),   s => { allResp   = s.val() || {}; paint(); });
  onValue(ref(db, PATH.leaderboard), s => { board     = s.val();       paint(); });
  onValue(ref(db, PATH.doubles),     s => { doubles   = s.val() || {}; paint(); });
  onValue(ref(db, PATH.reps),        s => { reps      = s.val() || {}; onReps(); paint(); });
  onValue(ref(db, PATH.repAnswers),  s => { repAns    = s.val() || {}; onRepAnswers(); paint(); });
  onValue(ref(db, PATH.state),       s => { state = s.val() || {}; onStateChange(); onWheel(); paint(); });
});

// ------------------------------------------------------------
//  階段變化 → 音效與頁碼重置
// ------------------------------------------------------------
let lastPhase = null, lastQid = null;

function onStateChange() {
  const phase = state.phase || PHASE.IDLE;
  const qid   = state.qid || null;
  if (phase === lastPhase && qid === lastQid) return;

  if (phase === PHASE.OPEN) {
    snd.stopBgm();
    snd.startBgm(state.limitSec || DEFAULT_LIMIT_SEC);
    startTicker();
  } else {
    snd.stopBgm();
    stopTicker();
    stage.classList.remove("tense", "shake");
    if (phase === PHASE.LOCKED && lastPhase === PHASE.OPEN) snd.timeUp();
    if (phase === PHASE.REVEAL) snd.fanfare();
    if (phase === PHASE.FINAL && lastPhase !== PHASE.FINAL) podiumStep = 0;
  }

  if (qid !== lastQid) {
    seenReps = new Set(Object.keys(repAns[qid] || {}));
    revealPage = 0;
  }
  if (phase === PHASE.REVEAL && lastPhase !== PHASE.REVEAL) revealPage = 0;

  lastPhase = phase;
  lastQid = qid;
}

// ------------------------------------------------------------
//  加倍轉盤
// ------------------------------------------------------------
let lastWheelId = null;

function onWheel() {
  const w = state.wheel;
  if (!w || !w.id || w.id === lastWheelId) return;
  lastWheelId = w.id;
  spinWheel(w.gid);
}

/** 主持人按下轉盤 → 全螢幕蓋上轉盤並轉到指定的組 */
function spinWheel(targetGid) {
  const gl = toSortedList(groups);
  if (!gl.length) return;
  const n = gl.length;
  const idx = Math.max(0, gl.findIndex(g => g.id === targetGid));
  const seg = 360 / n;

  document.querySelector(".wheel-overlay")?.remove();
  const ov = document.createElement("div");
  ov.className = "wheel-overlay";
  ov.innerHTML = `
    <h2 class="title-gold">🎡 分數加倍轉盤 🎡</h2>
    <div class="wheel-stage">
      <div class="wheel-ptr"></div>
      <div class="wheel-hub">×2</div>
      <svg viewBox="-105 -105 210 210" aria-hidden="true">
        <g class="wheel-spin" id="wheel-spin">${wheelSvg(gl, seg)}</g>
      </svg>
    </div>
    <div class="wheel-result pending" id="wheel-result">轉盤轉動中…</div>`;
  stage.appendChild(ov);

  // 幾何：wheelSvg 從 -90°（12 點鐘）開始順時針排，
  // 所以第 i 格的中心在「順時針 i*seg + seg/2 度」的位置。
  // CSS 的 rotate 正值也是順時針，轉了 R 之後中心會跑到 (centre + R)。
  // 指針固定在 12 點鐘（0 度），要讓它落在目標格中心就得 centre + R ≡ 0，
  // 也就是 R = 轉數*360 - centre。
  const centre = idx * seg + seg / 2;
  const turns  = 6;
  const finalR = turns * 360 - centre;
  const dur    = 5200;
  const spin   = ov.querySelector("#wheel-spin");
  const t0     = performance.now();
  let lastSeg  = null;

  function frame(now) {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 4);          // ease-out：先快後慢
    const r = finalR * eased;
    spin.style.transform = `rotate(${r}deg)`;

    const segIdx = Math.floor(r / seg);
    if (segIdx !== lastSeg) { lastSeg = segIdx; snd.wheelTick(); }

    if (p < 1) { requestAnimationFrame(frame); return; }

    snd.wheelStop();
    const res = ov.querySelector("#wheel-result");
    res.className = "wheel-result";
    res.innerHTML = `<span class="who">${escapeHtml(gl[idx].name)}</span>
                     <span class="x2">下一題 ×2</span>`;
    setTimeout(() => ov.remove(), 6000);
  }
  requestAnimationFrame(frame);
}

/** 轉盤的扇形與文字 */
function wheelSvg(gl, seg) {
  const R = 100;
  const palette = ["#1f3f9e", "#2a56c6"];
  return gl.map((g, i) => {
    const a0 = (i * seg - 90) * Math.PI / 180;
    const a1 = ((i + 1) * seg - 90) * Math.PI / 180;
    const x0 = (R * Math.cos(a0)).toFixed(2), y0 = (R * Math.sin(a0)).toFixed(2);
    const x1 = (R * Math.cos(a1)).toFixed(2), y1 = (R * Math.sin(a1)).toFixed(2);
    const big = seg > 180 ? 1 : 0;
    const mid = (i * seg + seg / 2 - 90);
    const tx  = (R * 0.62 * Math.cos(mid * Math.PI / 180)).toFixed(2);
    const ty  = (R * 0.62 * Math.sin(mid * Math.PI / 180)).toFixed(2);
    const fs  = Math.max(4.5, Math.min(11, 190 / gl.length)).toFixed(1);
    return `<path d="M0 0 L ${x0} ${y0} A ${R} ${R} 0 ${big} 1 ${x1} ${y1} Z"
              fill="${palette[i % 2]}" stroke="#ffc81f" stroke-width="0.8"/>
            <text x="${tx}" y="${ty}" fill="#fff" font-size="${fs}" font-weight="900"
              text-anchor="middle" dominant-baseline="central"
              transform="rotate(${mid + 90} ${tx} ${ty})">${escapeHtml(g.name)}</text>`;
  }).join("");
}

// 有新的組別代表就位就發出提示音（開場的掃碼頁最需要這個回饋）
let knownReps = null;
function onReps() {
  const now = new Set(Object.keys(reps));
  if (knownReps === null) { knownReps = now; return; }   // 第一次同步不叫
  const fresh = [...now].filter(g => !knownReps.has(g));
  knownReps = now;
  if (fresh.length) snd.joined();
}

let seenReps = new Set();
function onRepAnswers() {
  const qid = state.qid;
  if (!qid) return;
  const now = Object.keys(repAns[qid] || {});
  const fresh = now.filter(g => !seenReps.has(g));
  seenReps = new Set(now);
  if (fresh.length && state.phase === PHASE.OPEN) snd.confirmed();
}

// ------------------------------------------------------------
//  鍵盤
// ------------------------------------------------------------
addEventListener("keydown", e => {
  const phase = state.phase || PHASE.IDLE;

  if (phase === PHASE.FINAL) {
    if ([" ", "ArrowRight", "Enter"].includes(e.key)) { e.preventDefault(); stepPodium(+1); }
    if (e.key === "ArrowLeft")                        { e.preventDefault(); stepPodium(-1); }
    return;
  }

  if (phase === PHASE.IDLE) {
    if (e.key === "ArrowRight") { e.preventDefault(); introPage = Math.min(2, introPage + 1); paint(); }
    if (e.key === "ArrowLeft")  { e.preventDefault(); introPage = Math.max(0, introPage - 1); paint(); }
    return;
  }

  if (phase === PHASE.REVEAL) {
    const q = state.qid ? questions[state.qid] : null;
    if (!q) return;
    const last = revealPages(q).length - 1;
    if (e.key === "ArrowRight") { e.preventDefault(); revealPage = Math.min(last, revealPage + 1); paint(); }
    if (e.key === "ArrowLeft")  { e.preventDefault(); revealPage = Math.max(0, revealPage - 1); paint(); }
  }
});

function stepPodium(dir) {
  const next = Math.max(0, Math.min(PODIUM_TOP + 1, podiumStep + dir));
  if (next === podiumStep) return;
  podiumStep = next;
  if (dir > 0 && podiumStep >= 1 && podiumStep <= PODIUM_TOP) {
    podiumStep === PODIUM_TOP ? snd.victory() : snd.fanfare();
  }
  paint();
}

// ------------------------------------------------------------
//  倒數
// ------------------------------------------------------------
let ticker = null, lastTickSec = null;

function startTicker() {
  stopTicker();
  lastTickSec = null;
  ticker = setInterval(() => {
    const left = secondsLeft(state.openedAt, state.limitSec || DEFAULT_LIMIT_SEC, timeOffset);
    if (left === null) return;
    paintCountdown(left);
    if (left !== lastTickSec) {
      lastTickSec = left;
      if (left > 0) snd.tick(left);
    }
    stage.classList.toggle("tense", left <= 20);
    stage.classList.toggle("shake", left <= 5 && left > 0);
  }, 200);
}
function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

function paintCountdown(left) {
  const el = $("#s-countdown");
  if (!el) return;
  el.textContent = left;
  el.className = "countdown" + (left <= 5 ? " danger" : left <= 10 ? " warn" : "");
}

// ------------------------------------------------------------
//  版面工具
// ------------------------------------------------------------
function fitToBox(el, box, prop, startVh, minVh = 0.8) {
  let vh = startVh;
  el.style.setProperty(prop, vh.toFixed(2) + "vh");
  for (let i = 0; i < 40 && vh > minVh; i++) {
    if (box.scrollHeight <= box.clientHeight + 1) break;
    vh = Math.max(minVh, vh - 0.08);
    el.style.setProperty(prop, vh.toFixed(2) + "vh");
  }
}

const activeList = () => state.list === LISTS.DEMO ? LISTS.DEMO : LISTS.MAIN;
const qList  = () => questionsOf(questions, activeList());
const qIndex = qid => qList().findIndex(q => q.id === qid);

/** 這一題公布後要不要插一頁戰況：每 5 題一次，最後一題不插 */
function showsStandings(qid) {
  if (activeList() !== LISTS.MAIN) return false;
  const list = qList();
  const i = list.findIndex(q => q.id === qid);
  if (i < 0) return false;
  const isLast = i === list.length - 1;
  return !isLast && (i + 1) % STANDINGS_EVERY === 0;
}

function revealPages(q) {
  const pages = ["answer"];
  if ((q?.exImgFull || "").trim()) pages.push("fullimg");
  if (showsStandings(q?.id ?? state.qid)) pages.push("standings");
  pages.push("dist");
  return pages;
}

const PAGE_NAME = {
  answer:    "答案與說明",
  fullimg:   "補充大圖",
  standings: "目前戰況",
  dist:      "全場作答分布"
};
const INTRO_NAME = ["六大主題", "遊戲規則", "掃碼進場"];

function scoreboardNow() {
  return buildScoreboard(groups, questions, keys, allResp, repAns, state.revealed, LISTS.MAIN, doubles);
}

// ------------------------------------------------------------
//  主分派
// ------------------------------------------------------------
function paint() {
  if (!ready) return;
  const phase = state.phase || PHASE.IDLE;
  const qid   = state.qid || null;
  const q     = qid ? questions[qid] : null;

  // 待機與最終排行榜跟「某一題」無關，題號、類別、配分整個藏起來
  const onQuestion = !!q && phase !== PHASE.IDLE && phase !== PHASE.FINAL;

  badge.innerHTML = onQuestion ? `第 <b>${qIndex(qid) + 1}</b> 題` : "";
  badge.style.display = onQuestion ? "" : "none";

  const cat = categoryOf(q?.cat);
  $("#s-cat").textContent = onQuestion ? cat.name : "";
  $("#s-cat").style.setProperty("--cat", cat.color);
  $("#s-cat").style.display = onQuestion ? "" : "none";

  // 配分只有不是 +1 的時候才秀出來
  const pts = ptsOf(q);
  const showPts = onQuestion && pts !== 1;
  $("#s-pts").textContent = "+" + pts;
  $("#s-pts").style.display = showPts ? "" : "none";

  tip.textContent = "";
  stage.querySelector(".confetti")?.remove();

  if (phase === PHASE.FINAL)                                 return paintFinal();
  if (phase === PHASE.REVEAL && q)                           return paintRevealPage(qid, q);
  if ((phase === PHASE.OPEN || phase === PHASE.LOCKED) && q)  return paintPlay(qid, q, phase);
  return paintIntro();
}

// ============================================================
//  開場三頁
// ============================================================
function paintIntro() {
  foot.textContent = "開場";
  const prev = introPage > 0 ? "← " + INTRO_NAME[introPage - 1] : "";
  const next = introPage < 2 ? INTRO_NAME[introPage + 1] + " →" : "";
  tip.textContent = [prev, next].filter(Boolean).join("　　");

  if (introPage === 0) return paintThemes();
  if (introPage === 1) return paintRules();
  return paintJoin();
}

/** 第一頁：六大主題。直接用活動主視覺原圖。 */
function paintThemes() {
  body.innerHTML = `
    <div class="fullimg">
      <img src="assets/img/themes.jpg" alt="六大主題"
           onerror="this.parentElement.innerHTML = window.__themesFallback">
    </div>`;
}

// 圖載不出來時的備援：用類別色重畫六張卡，不會開天窗
window.__themesFallback = `
  <div class="themes">
    ${CATEGORIES.map((c, i) => `
      <div class="theme" style="--cat:${c.color}">
        <span class="fallback">${escapeHtml(c.name)}</span>
      </div>`).join("")}
  </div>`;

/** 第二頁：規則。後台沒放圖就用內建的流程示意圖。 */
function paintRules() {
  const img = (intro.rulesImg || "").trim();
  body.innerHTML = `
    <h2 class="title-gold intro-title">★ 遊戲規則 ★</h2>
    <div class="rules">
      <ol>
        <li>每組推派 <b>一位上台代表</b>，其餘是 <b>台下學員</b>。</li>
        <li>題目出現後開始 <b>倒數</b>，台下學員在手機上選 A／B／C／D。</li>
        <li>代表看得到自己這組的 <b>即時選擇比例</b>，再決定最終答案。</li>
        <li>代表按下 <b>確認送出</b> —— 送出後不能更改，並立刻顯示在螢幕上。</li>
        <li>代表答對 <b>+1 分</b>。</li>
        <li>台下學員答對率過半，<b>再 +1 分</b>。</li>
      </ol>
      <div class="pic">${img
        ? `<img src="${escapeHtml(img)}" alt="規則說明圖"
             onerror="this.replaceWith(document.createRange().createContextualFragment(window.__ruleSvg))">`
        : window.__ruleSvg}</div>
    </div>`;
}

/** 第三頁：QR Code + 各組代表就位狀況 */
function paintJoin() {
  const gl = toSortedList(groups);
  const ready_ = gl.filter(g => reps[g.id]).length;

  body.innerHTML = `
    <div class="joinpage">
      <div class="qrside">
        <h3 class="title-gold" style="margin:0;">掃碼進場</h3>
        <div class="qrbox"><img id="s-qr" alt="玩家端 QR Code"></div>
        <div class="url">${escapeHtml(playerUrl)}</div>
      </div>
      <div class="repside">
        <h3 class="title-gold">各組代表就位　<span style="color:var(--gold-lt)">${ready_} / ${gl.length}</span></h3>
        <div class="repgrid" id="s-repgrid"></div>
      </div>
    </div>`;

  paintQr();

  const el = $("#s-repgrid");
  const cols = gl.length ? gridColumns(gl.length) : 1;
  const rows = Math.max(1, Math.ceil(gl.length / cols));
  el.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  el.style.gridTemplateRows    = `repeat(${rows}, minmax(0, 1fr))`;
  el.innerHTML = gl.map(g => `
    <div class="repcard ${reps[g.id] ? "ready" : ""}">
      <span class="nm">${escapeHtml(g.name)}</span>
      <span class="st">${reps[g.id] ? "✓ 已就位" : "等待中"}</span>
    </div>`).join("") || `<p class="hint" style="font-size:2.4vh;">後台尚未建立組別</p>`;

  const cellH = el.clientHeight / rows, cellW = el.clientWidth / cols;
  el.style.setProperty("--rep-nm", Math.max(12, Math.min(cellH * 0.34, cellW * 0.16, 34)).toFixed(1) + "px");
  el.style.setProperty("--rep-st", Math.max(10, Math.min(cellH * 0.24, cellW * 0.12, 24)).toFixed(1) + "px");
}

const playerUrl = new URL("index.html", location.href).href;
let qrDataUrl = null;

async function paintQr() {
  const img = $("#s-qr");
  if (!img) return;
  if (qrDataUrl) { img.src = qrDataUrl; return; }
  try {
    if (!window.qrcode) {
      await new Promise((ok, no) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";
        s.onload = ok; s.onerror = no;
        document.head.appendChild(s);
      });
    }
    const qr = window.qrcode(0, "M");
    qr.addData(playerUrl);
    qr.make();
    qrDataUrl = qr.createDataURL(10, 4);
    const now = $("#s-qr");
    if (now) now.src = qrDataUrl;
  } catch {
    const box = $("#s-qr")?.parentElement;
    if (box) box.innerHTML = `<p style="color:#333; font-size:2vh; padding:2vh;">QR 產生器載不出來<br>請直接把網址給學員</p>`;
  }
}

// 內建的規則示意圖：後台沒放自己的圖時就用這張
window.__ruleSvg = `
<svg viewBox="0 0 420 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="遊戲流程示意">
  <defs>
    <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a5cff"/><stop offset="1" stop-color="#0a1b7a"/>
    </linearGradient>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#ffc81f"/>
    </marker>
  </defs>

  <g font-family="Noto Sans TC, sans-serif" text-anchor="middle">
    <rect x="14" y="18" width="170" height="86" rx="12" fill="url(#rg)" stroke="#35a8ff" stroke-width="2.5"/>
    <text x="99" y="48" fill="#fff" font-size="19" font-weight="700">📱 台下學員</text>
    <text x="99" y="74" fill="#a9bce8" font-size="14">各自選 A B C D</text>

    <rect x="236" y="18" width="170" height="86" rx="12" fill="url(#rg)" stroke="#ffc81f" stroke-width="2.5"/>
    <text x="321" y="48" fill="#fff" font-size="19" font-weight="700">🎤 上台代表</text>
    <text x="321" y="74" fill="#ffe680" font-size="14">看比例、下決定</text>

    <line x1="188" y1="61" x2="230" y2="61" stroke="#ffc81f" stroke-width="3" marker-end="url(#ar)"/>
    <text x="209" y="50" fill="#ffc81f" font-size="11">比例</text>

    <rect x="125" y="132" width="170" height="60" rx="12" fill="#0d2a14" stroke="#2fd96b" stroke-width="2.5"/>
    <text x="210" y="169" fill="#7bffab" font-size="19" font-weight="700">✓ 確認送出</text>
    <line x1="321" y1="108" x2="255" y2="128" stroke="#ffc81f" stroke-width="3" marker-end="url(#ar)"/>

    <rect x="14" y="220" width="180" height="64" rx="12" fill="#241a02" stroke="#ffc81f" stroke-width="2.5"/>
    <text x="104" y="246" fill="#ffe680" font-size="16" font-weight="700">代表答對</text>
    <text x="104" y="270" fill="#ffc81f" font-size="20" font-weight="900">+1</text>

    <rect x="226" y="220" width="180" height="64" rx="12" fill="#241a02" stroke="#ffc81f" stroke-width="2.5"/>
    <text x="316" y="246" fill="#ffe680" font-size="16" font-weight="700">學員答對過半</text>
    <text x="316" y="270" fill="#ffc81f" font-size="20" font-weight="900">+1</text>

    <line x1="180" y1="196" x2="120" y2="214" stroke="#ffc81f" stroke-width="3" marker-end="url(#ar)"/>
    <line x1="240" y1="196" x2="300" y2="214" stroke="#ffc81f" stroke-width="3" marker-end="url(#ar)"/>
  </g>
</svg>`;

// ============================================================
//  出題中
// ============================================================
function paintPlay(qid, q, phase) {
  const locked = phase === PHASE.LOCKED;
  foot.textContent = locked ? "已截止作答，準備公布" : "開放作答中";

  const left = secondsLeft(state.openedAt, state.limitSec || DEFAULT_LIMIT_SEC, timeOffset);

  body.innerHTML = `
    <div class="qblock" id="s-qblock">
      <div style="flex:1 1 auto; min-width:0;">
        <div class="big-q" id="s-bigq">${escapeHtml(q.text || "")}</div>
        <div class="opt-row">
          ${LETTERS.filter(L => q[L.toLowerCase()]).map(L =>
            `<div class="opt-mini"><span class="k">${L}</span><span class="t">${escapeHtml(q[L.toLowerCase()])}</span></div>`
          ).join("")}
        </div>
      </div>
      <div class="countdown" id="s-countdown">${locked ? 0 : (left ?? "–")}</div>
    </div>
    <div class="grid" id="s-grid"></div>`;

  if (!locked && left !== null) paintCountdown(left);

  // 題目區塊有高度上限，剩下的都留給各組格子 —— 組數多的時候才不會擠成一團
  const qb = $("#s-qblock");
  fitToBox($("#s-bigq"), qb, "font-size", 4.2, 1.8);
  for (const line of qb.querySelectorAll(".opt-mini")) {
    fitToBox(line.querySelector(".t"), line, "font-size", 3, 1.5);
  }

  paintGrid(qid, false);
}

function paintGrid(qid, revealMode) {
  const el = $("#s-grid");
  if (!el) return;

  const gl   = toSortedList(groups);
  const cols = Number(state.gridCols) > 0 ? Number(state.gridCols) : gridColumns(gl.length);
  const rows = Math.max(1, Math.ceil(gl.length / cols));
  const key  = revealMode ? keys[qid] : null;
  const showLetters = revealMode || state.showRepLetters !== false;

  el.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  el.style.gridTemplateRows    = `repeat(${rows}, minmax(0, 1fr))`;

  const doubledGid = doubles[qid] || null;

  el.innerHTML = gl.map(g => {
    const a = repAns[qid]?.[g.id];
    const c = LETTERS.includes(a?.c) ? a.c : null;
    const cls = ["cellbox"];
    if (g.id === doubledGid) cls.push("doubled");
    let mark = "";
    if (c) {
      cls.push("done");
      if (revealMode && key) {
        cls.push(c === key ? "right" : "wrongc");
        mark = c === key ? "✅" : "❌";
      }
    }
    // 左邊組名、右邊答案
    const inner = c
      ? `<span class="glet">${showLetters ? c : "✓"}</span>`
      : `<span class="waiting">···</span>`;
    return `<div class="${cls.join(" ")}">
      <span class="gname">${escapeHtml(g.name)}</span>
      ${g.id === doubledGid ? `<span class="x2tag">×2</span>` : ""}
      ${inner}
      ${mark ? `<span class="mark">${mark}</span>` : ""}
    </div>`;
  }).join("");

  // 字級要從格子「實際拿到的高度」算 —— 出題畫面給整個下半部，
  // 公布畫面只給 26vh，用固定的 vh 公式會在公布畫面把內容切掉。
  // 格子是橫的（組名左、答案右），所以字級主要由「格高」決定，
  // 再用格寬把過長的組名擋下來。
  const cellH = el.clientHeight / rows;
  const cellW = el.clientWidth  / cols;
  // 組名要跟答案共用同一列的寬度，所以兩邊都要留餘裕：
  // 字母受格高限制、組名受格寬限制，上限壓低一點才不會被 ellipsis 切掉。
  el.style.setProperty("--cell-let",
    Math.max(16, Math.min(cellH * 0.6, cellW * 0.26, 100)).toFixed(1) + "px");
  el.style.setProperty("--cell-name",
    Math.max(11, Math.min(cellH * 0.34, cellW * 0.13, 32)).toFixed(1) + "px");

  if (!revealMode) {
    const done = Object.keys(repAns[qid] || {}).length;
    tip.textContent = `${done} / ${gl.length} 組已確認`;
  }
}

// ============================================================
//  公布階段
// ============================================================
function paintRevealPage(qid, q) {
  const pages = revealPages(q);
  revealPage = Math.min(revealPage, pages.length - 1);

  ({ answer: paintReveal, fullimg: paintFullImage, standings: paintStandings, dist: paintDistribution })
    [pages[revealPage]](qid, q);

  const prev = revealPage > 0 ? "← " + PAGE_NAME[pages[revealPage - 1]] : "";
  const next = revealPage < pages.length - 1 ? PAGE_NAME[pages[revealPage + 1]] + " →" : "";
  tip.textContent = [prev, next].filter(Boolean).join("　　");
}

/** 正解大字與說明同時出現，下面接各組對錯格 */
function paintReveal(qid, q) {
  foot.textContent = "已公布答案";

  const key    = keys[qid];
  const hasImg = !!(q.exImg || "").trim();
  const text   = (q.exText || "").trim();

  body.innerHTML = `
    <div class="reveal-top">
      <div class="reveal-ans">
        <div class="title-gold" style="font-size:2.8vh;">🎉 正確答案 🎉</div>
        <div class="reveal-letter">${key || "—"}</div>
      </div>
      <div class="reveal-ex">
        <h3 class="title-gold" style="font-size:3vh; margin:0 0 1vh;">💡 說明</h3>
        <div class="explain ${hasImg ? "" : "noimg"}">
          <div class="txt" id="s-extext">${text ? escapeHtml(text) : "（這一題後台還沒有填說明）"}</div>
          <div class="pic">${hasImg ? `<img src="${escapeHtml(q.exImg)}" alt="說明圖片"
            onerror="this.closest('.explain').classList.add('noimg')">` : ""}</div>
        </div>
      </div>
    </div>
    <div class="grid" id="s-grid" style="flex:0 0 26vh;"></div>`;

  const t = $("#s-extext");
  fitToBox(t, t, "font-size", 3, 1.4);
  paintGrid(qid, true);
}

function paintFullImage(qid, q) {
  foot.textContent = "補充說明";
  body.innerHTML = `
    <div class="fullimg">
      <img src="${escapeHtml(q.exImgFull)}" alt="補充說明大圖"
           onerror="this.parentElement.innerHTML='<p class=&quot;hint&quot; style=&quot;font-size:2.6vh&quot;>圖片載不出來，請確認後台填的網址</p>'">
    </div>`;
}

function paintDistribution(qid, q) {
  foot.textContent = "全場作答分布";

  const key = keys[qid];
  const t   = tallyAllMembers(allResp[qid]);

  body.innerHTML = `
    <div class="big-q" style="font-size:3.2vh; padding:1.8vh 2vw; flex:0 0 auto;">${escapeHtml(q.text || "")}</div>
    <div class="bars screen-bars" style="flex:0 0 auto; margin-top:1.6vh;">
      ${LETTERS.filter(L => q[L.toLowerCase()]).map(L => {
        const n = t[L], pct = t.total ? Math.round(n / t.total * 100) : 0;
        return `<div class="bar-row">
          <span class="bar-key">${L}</span>
          <span class="bar-opt">${escapeHtml(q[L.toLowerCase()])}</span>
          <span class="bar-track"><span class="bar-fill${L === key ? " is-correct" : ""}" style="width:${pct}%"></span></span>
          <span class="bar-num">${pct}%（${n}）</span>
        </div>`;
      }).join("")}
    </div>
    <p class="hint center" style="font-size:2.2vh; margin:1.4vh 0 0;">
      台下學員共 ${t.total} 人作答　正解 <b style="color:var(--gold)">${key || "—"}</b>
    </p>`;
}

/** 每五題插播：目前戰況前五名 */
function paintStandings(qid) {
  foot.textContent = "目前戰況";
  const rows = scoreboardNow().rows.slice(0, STANDINGS_TOP);
  const done = qIndex(qid) + 1;

  body.innerHTML = `
    <h2 class="title-gold intro-title" style="margin:0 0 .6vh;">⚡ 目前戰況 ⚡</h2>
    <p class="hint center" style="font-size:2.3vh; margin:0 0 2vh;">已完成 ${done} 題　顯示前 ${STANDINGS_TOP} 名</p>
    <div class="card" style="overflow:hidden;">
      <table class="rank rank-screen">
        <thead><tr>
          <th style="width:9vh;">#</th><th>組別</th>
          <th class="n">總分</th><th class="n">代表答對</th><th class="n">學員過半</th>
        </tr></thead>
        <tbody>${
          rows.length
            ? rows.map((r, i) => `<tr class="${i === 0 ? "top1" : ""}">
                <td>${i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1}</td>
                <td>${escapeHtml(r.name)}</td>
                <td class="n">${r.points}</td>
                <td class="n">${r.repCorrect}</td>
                <td class="n">${r.memberBonus}</td>
              </tr>`).join("")
            : `<tr><td colspan="5" class="hint">尚無資料</td></tr>`
        }</tbody>
      </table>
    </div>`;
  const t = $(".rank-screen");
  fitToBox(t, t.parentElement, "--rfs", 3.6);
}

// ============================================================
//  最終：排行榜（只公布前三名，逐一揭曉）→ 類別分析
// ============================================================
function paintFinal() {
  const rows = board?.rows || scoreboardNow().rows;

  if (podiumStep > PODIUM_TOP) return paintMatrixScreen();

  foot.textContent = "排行榜";
  tip.textContent = podiumStep === 0
    ? "按空白鍵開始公布 →"
    : podiumStep < PODIUM_TOP
      ? `按空白鍵公布第 ${PODIUM_TOP - podiumStep} 名 →`
      : "按空白鍵看類別分析 →";

  const top = rows.slice(0, PODIUM_TOP);
  // 版面順序是 2 - 1 - 3，揭曉順序是 3 → 2 → 1
  const layout = [
    { rank: 2, cls: "p2", medal: "🥈" },
    { rank: 1, cls: "p1", medal: "🥇" },
    { rank: 3, cls: "p3", medal: "🥉" }
  ];

  body.innerHTML = `
    <h2 class="title-gold intro-title" style="margin:0 0 .8vh;">★ 排行榜 ★</h2>
    <div class="podium">
      ${layout.map(({ rank, cls, medal }) => {
        const r = top[rank - 1];
        const revealedAt = PODIUM_TOP - rank + 1;      // 第三名在第 1 步、第一名在第 3 步
        const shown = podiumStep >= revealedAt;
        if (!r) return `<div class="place ${cls}"></div>`;
        return `<div class="place ${cls} ${shown ? "shown" : ""}">
          <div class="medal">${medal}</div>
          <div class="gname">${escapeHtml(r.name)}</div>
          <div class="score">${r.points} 分</div>
          <div class="detail">代表答對 ${r.repCorrect}　學員過半 ${r.memberBonus}</div>
          <div class="block">${rank}</div>
        </div>`;
      }).join("")}
    </div>`;

  if (podiumStep >= PODIUM_TOP && top.length) dropConfetti();
}

function dropConfetti() {
  stage.querySelector(".confetti")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "confetti";
  const colors = ["#ffc81f", "#35a8ff", "#e6266f", "#2fd96b", "#8b5cf6", "#fff"];
  let html = "";
  for (let i = 0; i < 90; i++) {
    const left = Math.random() * 100;
    const dur  = 2.6 + Math.random() * 2.6;
    const del  = Math.random() * 1.6;
    const col  = colors[i % colors.length];
    html += `<i style="left:${left.toFixed(1)}%; background:${col};
      animation-duration:${dur.toFixed(2)}s; animation-delay:${del.toFixed(2)}s"></i>`;
  }
  wrap.innerHTML = html;
  stage.appendChild(wrap);
  setTimeout(() => wrap.remove(), 9000);
}

function paintMatrixScreen() {
  foot.textContent = "類別分析";
  tip.textContent  = "← 按空白鍵回到排行榜";

  const mx = categoryMatrix(scoreboardNow());
  if (!mx.cats.length || !mx.rows.length) {
    body.innerHTML = `<p class="hint center" style="font-size:2.8vh;">還沒有已公布的正式題目</p>`;
    return;
  }

  const wins    = columnWinners(mx);
  const bestOf  = groupBestCategories(mx);
  const bestIdx = new Map(bestOf.map(b => [b.gid, b.cat ? mx.cats.findIndex(c => c.id === b.cat.id) : -1]));

  body.innerHTML = `
    <h2 class="title-gold center" style="font-size:4.6vh; margin:0 0 1.2vh;">各組強項分析</h2>
    <p class="hint center" style="font-size:2.1vh; margin:0 0 1.4vh;">
      數字為該類別得分率　<b style="color:var(--gold)">金色</b>＝該類別最強的組
      <b style="color:var(--cyan-lt)">藍框</b>＝該組最強的類別
    </p>
    <div class="card" style="overflow:hidden;">
      <table class="matrix matrix-screen">
        <thead><tr>
          <th class="g">組別</th>
          ${mx.cats.map(c => `<th><span style="--cat:${c.color}">${escapeHtml(c.name)}</span></th>`).join("")}
        </tr></thead>
        <tbody>
          ${mx.rows.map((row, ri) => `<tr>
            <td class="g">${escapeHtml(row.name)}</td>
            ${row.cells.map((cell, ci) => {
              const cls = [
                cell.rate === null ? "none" : "",
                wins[ci] === ri ? "colwin" : "",
                bestIdx.get(row.gid) === ci ? "rowbest" : ""
              ].filter(Boolean).join(" ");
              return `<td class="${cls}">${
                cell.rate === null ? "–" : `${cell.rate}%<small>${cell.points}/${cell.max}</small>`
              }</td>`;
            }).join("")}
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  const t = $(".matrix-screen");
  fitToBox(t, t.parentElement, "--mfs", 2.6);
}
