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
  blocksOf, groupBlocks, isSoloMedia, videoEmbed, TEXT_SIZE_VH, IMG_SIZE_VH,
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
// 開場影片也要有聲音，但瀏覽器一樣要先有一次點擊 —— 沿用這道門
let soundOn = false;

show($("#sound-gate"), true);
$("#btn-sound").addEventListener("click", async () => {
  await snd.unlock();
  soundOn = true;
  show($("#sound-gate"), false);
  unmuteThemeVideo();
});
$("#btn-nosound").addEventListener("click", e => {
  e.preventDefault();
  show($("#sound-gate"), false);
});

/** 影片一律先靜音自動播（不然會被瀏覽器擋掉），解鎖後才打開聲音 */
function unmuteThemeVideo() {
  const v = $("#s-themevid");
  if (!v) return;
  v.muted = false;
  v.volume = 1;
  v.play?.().catch(() => {});
}

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

  // 出題就把轉盤收掉 —— 在那之前它會一直留在畫面上
  if (phase === PHASE.OPEN || qid !== lastQid) closeWheel();

  // 一離開該階段就把對應的背景音樂收掉
  if (phase !== PHASE.REVEAL) snd.stopRevealBgm();
  if (phase !== PHASE.FINAL)  snd.stopFinalBgm();

  if (phase === PHASE.OPEN) {
    snd.stopBgm();
    snd.startBgm();
    startTicker();
  } else {
    snd.stopBgm();
    stopTicker();
    stage.classList.remove("tense", "shake");
    if (phase === PHASE.LOCKED && lastPhase === PHASE.OPEN) snd.timeUp();
    // 撞擊聲下去，接著鋼琴弦樂鋪在講解底下
    if (phase === PHASE.REVEAL) { snd.fanfare(); snd.startRevealBgm(); }
    if (phase === PHASE.FINAL) {
      if (lastPhase !== PHASE.FINAL) podiumStep = 0;
      snd.startFinalBgm();          // 排行榜的 funk 墊底
    }
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

function closeWheel() {
  document.querySelector(".wheel-overlay")?.remove();
}

function onWheel() {
  const w = state.wheel;
  if (!w || !w.id) {                    // 主持人按了「取消加倍」→ 轉盤收掉
    if (lastWheelId !== null) { lastWheelId = null; closeWheel(); }
    return;
  }
  if (w.id === lastWheelId) return;
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
    <h2 class="title-gold"><span class="emoji">🎡</span> 分數加倍轉盤 <span class="emoji">🎡</span></h2>
    <div class="wheel-stage">
      <div class="wheel-ptr"></div>
      <div class="wheel-hub">×2</div>
      <svg viewBox="-105 -105 210 210" aria-hidden="true">
        <g class="wheel-spin" id="wheel-spin">${wheelSvg(gl, seg)}</g>
      </svg>
    </div>
    <div class="wheel-result pending" id="wheel-result">轉盤轉動中…</div>
    <p class="wheel-hint" id="wheel-hint"></p>`;
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
    // 用 SVG 的 transform 屬性，不要用 CSS transform ——
    // CSS 的 transform-origin: 50% 50% 在 <g> 上會解析成使用者座標 (105,105)，
    // 不是圓心 (0,0)，整個轉盤會繞著偏移點公轉而不是自轉。
    // SVG 的 rotate(deg) 不帶 cx,cy 時就是繞使用者原點，剛好是圓心。
    spin.setAttribute("transform", `rotate(${r})`);

    const segIdx = Math.floor(r / seg);
    if (segIdx !== lastSeg) { lastSeg = segIdx; snd.wheelTick(); }

    if (p < 1) { requestAnimationFrame(frame); return; }

    snd.wheelStop();
    const res = ov.querySelector("#wheel-result");
    res.className = "wheel-result";
    res.innerHTML = `<span class="who">${escapeHtml(gl[idx].name)}</span>
                     <span class="x2">下一題 ×2</span>`;
    // 轉完就停在這裡，讓主持人有時間講話；等他按「出題／下一題」才收掉
    ov.querySelector("#wheel-hint").textContent = "主持人按「下一題」就會關閉";
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
              transform="rotate(${mid} ${tx} ${ty})">${escapeHtml(g.name)}</text>`;
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
  // 轉盤蓋著的時候先處理它：Esc 手動關掉，其餘按鍵不要穿透到底下的頁面
  if (document.querySelector(".wheel-overlay")) {
    if (e.key === "Escape") { e.preventDefault(); closeWheel(); }
    return;
  }

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
/** 題幹外框：單數題黃、偶數題綠 */
const qParity = qid => (qIndex(qid) + 1) % 2 === 1 ? "odd" : "even";

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

  // 加倍的組別放在頂部列，格子裡只留紅框
  const dblGid = onQuestion ? doubles[qid] : (phase === PHASE.IDLE ? null : null);
  const dblEl = $("#s-dbl");
  if (dblGid && groups[dblGid]) {
    dblEl.textContent = "🎡 " + groups[dblGid].name + " ×2";
    dblEl.style.display = "";
  } else {
    dblEl.style.display = "none";
  }

  // 六大主題那一頁要滿版，頂部列與頁尾都收起來
  stage.classList.toggle("bleed", phase === PHASE.IDLE && introPage === 0);

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

/** 第一頁：六大主題。整張主視覺直接滿版鋪滿投影畫面。 */
function paintThemes() {
  // 資料一有更新就會重畫整頁；影片已經在播就別重建，否則會一直跳回第一幀
  if (body.querySelector("#s-themevid, .themes")) return;

  body.innerHTML = `
    <video class="bleed-img" id="s-themevid" src="assets/video/themes.mp4"
         autoplay loop muted playsinline
         onerror="this.outerHTML = '<div class=&quot;themes&quot;>' + window.__themesFallback + '</div>'"></video>`;

  if (soundOn) unmuteThemeVideo();
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

  // 中間欄：規則條列 ＋ 進場 QR
  const middle = `
    <div class="ruleside">
      <ol>
        <li>每組推派 <b>一位上台代表</b>，其餘是 <b>台下學員</b>。</li>
        <li>題目出現後開始 <b>倒數</b>，台下學員在手機上選 A／B／C／D。</li>
        <li>代表看得到自己這組的 <b>即時選擇比例</b>，再決定最終答案。</li>
        <li>代表按下 <b>確認送出</b> —— 送出後不能更改，並立刻顯示在螢幕上。</li>
        <li>代表答對 <b>+1 分</b>。</li>
        <li>台下學員答對率過半，<b>再 +1 分</b>。</li>
      </ol>
      <div class="qr-mini">
        <div class="qrbox"><img id="s-qr" alt="玩家端 QR Code"></div>
        <div class="cap">
          <b>📱 還沒進場的現在就掃</b>
          <span>${escapeHtml(playerUrl)}</span>
        </div>
      </div>
    </div>`;

  // 預設把兩支手機分站左右兩側，中間放規則；
  // 後台放了自訂規則圖的話就回到「規則在左、圖在右」的兩欄版面。
  body.innerHTML = `
    <h2 class="title-gold intro-title">★ 遊戲規則 ★</h2>
    ${img
      ? `<div class="rules">
           ${middle}
           <div class="pic">
             <img src="${escapeHtml(img)}" alt="規則說明圖"
                  onerror="this.replaceWith(document.createRange()
                    .createContextualFragment(window.__phonesFallback()))">
           </div>
         </div>`
      : `<div class="rules rules-3col">
           <div class="pic">${phoneMockHtml("member")}</div>
           ${middle}
           <div class="pic">${phoneMockHtml("rep")}</div>
         </div>`}`;

  paintQr();
  fitPhones();
}

/**
 * 規則頁的示意圖：直接用學員端真正的元件樣式組出手機畫面，
 * 所以跟他們手上看到的一模一樣，之後改樣式也會自動跟著變。
 */
function phoneMockHtml(...who) {
  return `<div class="phonerow">${who.map(w => phoneFigure(w)).join("")}</div>`;
}

// inline 的 onerror 是在全域執行的，module 內的函式它看不到 —— 得掛到 window 上
window.__phonesFallback = () => phoneMockHtml("member", "rep");

/** who："member" 台下學員／"rep" 上台代表（紅底，多一塊學員選擇比例） */
function phoneFigure(who) {
  const opts = [
    ["A", "直接錄音存證"],
    ["B", "找時間好好說"],
    ["C", "貼紙條抗議"],
    ["D", "跟幹部檢舉"]
  ];
  const optHtml = opts.map(([L, t]) =>
    `<div class="opt${L === "B" ? " picked" : ""}">
       <span class="letter">${L}</span><span class="label">${t}</span>
     </div>`).join("");

  const qhead = `
    <div class="qhead">
      <span class="qbadge">第 <b>3</b> 題</span>
      <span class="timer warn">18</span>
    </div>`;

  if (who === "rep") {
    const bars = [["A", 14], ["B", 57], ["C", 15], ["D", 14]].map(([L, p]) =>
      `<div class="bar-row"><span class="bar-key">${L}</span>
         <span class="bar-track"><span class="bar-fill" style="width:${p}%"></span></span>
         <span class="bar-num">${p}%</span></div>`).join("");

    return `
      <figure class="phone rep">
        <figcaption>🎤 上台代表</figcaption>
        <div class="phones">
          <div class="phone-screen rep-theme">
            ${qhead}
            <div class="card" style="margin-bottom:12px;">
              <strong class="title-gold" style="font-size:15px;">學員的選擇</strong>
              <div class="bars" style="margin-top:8px;">${bars}</div>
            </div>
            <div class="opts">${optHtml}</div>
            <button class="btn wide" style="margin-top:12px;">確認送出 <b>B</b></button>
          </div>
        </div>
      </figure>`;
  }

  return `
    <figure class="phone member">
      <figcaption>📱 台下學員</figcaption>
      <div class="phones">
        <div class="phone-screen">
          ${qhead}
          <div class="qpanel"><p>室友半夜一直講電話，最好的第一步是？</p></div>
          <div class="opts">${optHtml}</div>
          <p class="hint" style="margin-top:10px;">已送出 B，截止前都可以改</p>
        </div>
      </div>
    </figure>`;
}

/** 手機用原尺寸組好再整體縮到放得下，字級比例才不會跑掉。
    標題留在 .phones 外面不跟著縮，兩支手機的標題大小才會一致。 */
function fitPhones() {
  document.querySelectorAll(".rules .phone-screen").forEach(scr => {
    const box = scr.parentElement;
    if (!box) return;
    scr.style.transform = "";
    const w = scr.offsetWidth, h = scr.offsetHeight;
    if (!w || !h) return;
    const k = Math.min(box.clientWidth / w, box.clientHeight / h, 1);
    scr.style.transform = `scale(${k.toFixed(3)})`;
  });
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
        <div class="big-q ${qParity(qid)}" id="s-bigq">${escapeHtml(q.text || "")}</div>
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
    // ×2 只用紅框標示，不在格子裡放文字 —— 組名本來就快撐滿，
    // 再插一個 chip 會把「第 13 組」擠成「第…×2」
    if (revealMode) cls.push("revealed");
    return `<div class="${cls.join(" ")}">
      <span class="gname">${escapeHtml(g.name)}</span>
      ${inner}
      <span class="mark">${mark}</span>
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
  const nameSize = Math.max(11, Math.min(cellH * 0.34, cellW * 0.13, 32));
  el.style.setProperty("--cell-name", nameSize.toFixed(1) + "px");

  // 公布時三欄等分，組名那欄會變窄。與其猜一個縮放係數，直接量到不溢出為止 ——
  // 組數、欄數、組名長度都會變，算的不準。
  if (revealMode) {
    const names = [...el.querySelectorAll(".gname")];
    let f = 0.8;
    const apply = () => el.style.setProperty("--cell-name-rev",
      Math.max(9, nameSize * f).toFixed(1) + "px");
    apply();
    for (let i = 0; i < 16 && nameSize * f > 9; i++) {
      if (!names.some(n => n.scrollWidth > n.clientWidth + 1)) break;
      f -= 0.04;
      apply();
    }
  }

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

  const key = keys[qid];

  body.innerHTML = `
    <div class="reveal-top">
      <div class="reveal-ans">
        <div class="title-gold" style="font-size:2.8vh;"><span class="emoji">🎉</span> 正確答案 <span class="emoji">🎉</span></div>
        <div class="reveal-letter">${key || "—"}</div>
      </div>
      <div class="reveal-ex">
        <h3 class="title-gold" style="font-size:3vh; margin:0 0 1vh;"><span class="emoji">💡</span> 說明</h3>
        <div class="exblocks${isSoloMedia(blocksOf(q)) ? " solo" : ""}" id="s-exblocks">${blocksHtml(q)}</div>
      </div>
    </div>
    <div class="grid" id="s-grid" style="flex:0 0 26vh;"></div>`;

  fitBlocks($("#s-exblocks"));
  paintGrid(qid, true);
}

/**
 * 把後台排好的說明區塊畫出來。
 * 半行的區塊會自動並排成兩欄；沒有區塊就顯示提示，不要開天窗。
 */
function blocksHtml(q) {
  const blocks = blocksOf(q);
  if (!blocks.length) {
    return `<p class="hint" style="font-size:2.4vh;"></p>`;
  }
  const one = b => {
    const cls = `exblock ${b.w} ${b.align}`;
    if (b.t === "img") {
      return `<div class="${cls}"><img src="${escapeHtml(b.v)}" alt=""
        style="--ih:${IMG_SIZE_VH[b.size]}vh"
        onerror="this.replaceWith(Object.assign(document.createElement('span'),
          {className:'imgfail', textContent:'圖片載不出來'}))"></div>`;
    }
    if (b.t === "video") {
      const v = videoEmbed(b.v);
      const inner = v.kind === "embed"
        ? `<iframe src="${escapeHtml(v.src)}" title="說明影片" frameborder="0"
             allow="accelerometer; autoplay; encrypted-media; picture-in-picture"
             allowfullscreen></iframe>`
        : `<video src="${escapeHtml(v.src)}" controls playsinline preload="metadata"></video>`;
      return `<div class="${cls}"><div class="vidbox"
        style="--ih:${IMG_SIZE_VH[b.size]}vh">${inner}</div></div>`;
    }
    const tag = b.t === "head" ? "h4" : "p";
    return `<${tag} class="${cls} ${b.t}"
      style="--fs:${TEXT_SIZE_VH[b.size]}vh">${escapeHtml(b.v)}</${tag}>`;
  };
  // 連續的「自動寬」區塊包成一列，中間只留一點點縫
  return groupBlocks(blocks).map(r => r.auto
    ? `<div class="exrow ${r.align}">${r.items.map(one).join("")}</div>`
    : one(r.items[0])
  ).join("");
}

/** 排太滿就整體縮小，保證一頁塞得下 */
function fitBlocks(el) {
  if (!el) return;
  let k = 1;
  el.style.setProperty("--blk-scale", k);
  for (let i = 0; i < 24 && k > 0.45; i++) {
    if (el.scrollHeight <= el.clientHeight + 1) break;
    k -= 0.04;
    el.style.setProperty("--blk-scale", k.toFixed(2));
  }
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
    <div class="big-q ${qParity(qid)}" style="font-size:3.2vh; padding:1.8vh 2vw; flex:0 0 auto;">${escapeHtml(q.text || "")}</div>
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
    <h2 class="title-gold intro-title" style="margin:0 0 .6vh;"><span class="emoji">⚡</span> 目前戰況 <span class="emoji">⚡</span></h2>
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
