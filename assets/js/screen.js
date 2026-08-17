// ============================================================
//  投影統計頁 —— 主持人切到瀏覽器全螢幕給觀眾看
//  需要主持人身分（原始作答只有 /admins 名單讀得到）。
//  在同一個瀏覽器開過 host.html 登入後，這頁會自動沿用登入狀態。
// ============================================================

import {
  db, auth, ref, onValue, onAuthStateChanged,
  PATH, PHASE, LISTS, LETTERS, DEFAULT_LIMIT_SEC,
  categoryOf, questionsOf, tallyAllMembers, secondsLeft, isHost,
  gridColumns, buildScoreboard, categoryMatrix, groupBestCategories, columnWinners,
  $, show, escapeHtml, toSortedList
} from "./common.js";

import * as snd from "./sounds.js";

let groups = {}, questions = {}, keys = {}, allResp = {}, repAns = {}, state = {}, board = null;
let ready = false, timeOffset = 0;

const stage = $("#stage");
const body  = $("#s-body");
const badge = $("#s-badge");
const foot  = $("#s-phase");
const tip   = $("#s-tip");

// 結束畫面在「排行榜」與「類別分析」之間切換
let finalView = "rank";
// 公布階段的頁序：答案＋說明 →（整頁大圖，有填才有）→ 全場作答分布
let revealPage = 0;

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
//  操作：空白鍵切換最終畫面
// ------------------------------------------------------------
function toggleFinalView() {
  if ((state.phase || "") !== PHASE.FINAL) return;
  finalView = finalView === "rank" ? "matrix" : "rank";
  paint();
}
addEventListener("keydown", e => {
  if ([" ", "ArrowRight", "ArrowLeft", "Enter"].includes(e.key)) { e.preventDefault(); toggleFinalView(); }
});

// ------------------------------------------------------------
//  登入與資料
// ------------------------------------------------------------
onAuthStateChanged(auth, async user => {
  const ok = await isHost(user);
  if (!ok) {
    body.innerHTML = `<div class="card center stack" style="max-width:60vw; margin:0 auto;">
      <h2 class="title-gold" style="font-size:4vh; margin:0;">尚未登入</h2>
      <p class="hint" style="font-size:2.2vh;">請先在同一個瀏覽器開啟
        <a href="host.html" style="color:var(--gold-lt)">主持人控制台</a> 登入，再回到這一頁。</p>
    </div>`;
    return;
  }
  if (ready) return;
  ready = true;
  onValue(ref(db, "/.info/serverTimeOffset"), s => { timeOffset = s.val() || 0; });
  onValue(ref(db, PATH.groups),      s => { groups    = s.val() || {}; paint(); });
  onValue(ref(db, PATH.questions),   s => { questions = s.val() || {}; paint(); });
  onValue(ref(db, PATH.answerKey),   s => { keys      = s.val() || {}; paint(); });
  onValue(ref(db, PATH.responses),   s => { allResp   = s.val() || {}; paint(); });
  onValue(ref(db, PATH.leaderboard), s => { board     = s.val();       paint(); });
  onValue(ref(db, PATH.repAnswers),  s => { repAns    = s.val() || {}; onRepAnswers(); paint(); });
  onValue(ref(db, PATH.state),       s => { state     = s.val() || {}; onStateChange(); paint(); });
});

// ------------------------------------------------------------
//  階段變化 → 音效
// ------------------------------------------------------------
let lastPhase = null, lastQid = null;

function onStateChange() {
  const phase = state.phase || PHASE.IDLE;
  const qid   = state.qid || null;
  const changed = phase !== lastPhase || qid !== lastQid;
  if (!changed) return;

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
    if (phase === PHASE.FINAL && lastPhase !== PHASE.FINAL) { finalView = "rank"; snd.victory(); }
  }

  if (qid !== lastQid) {
    seenReps = new Set(Object.keys(repAns[qid] || {}));
    revealPage = 0;                        // 換題就回到答案頁
  }
  if (phase === PHASE.REVEAL && lastPhase !== PHASE.REVEAL) revealPage = 0;
  lastPhase = phase;
  lastQid = qid;
}

/** 有新的組別按下確認 → 確認音效 */
let seenReps = new Set();
function onRepAnswers() {
  const qid = state.qid;
  if (!qid) return;
  const now = Object.keys(repAns[qid] || {});
  const fresh = now.filter(g => !seenReps.has(g));
  seenReps = new Set(now);
  if (fresh.length && (state.phase === PHASE.OPEN)) snd.confirmed();
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

function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

function paintCountdown(left) {
  const el = $("#s-countdown");
  if (!el) return;
  el.textContent = left;
  el.className = "countdown" + (left <= 5 ? " danger" : left <= 10 ? " warn" : "");
}

// ------------------------------------------------------------
//  版面
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

function paint() {
  if (!ready) return;
  const phase = state.phase || PHASE.IDLE;
  const qid   = state.qid || null;
  const q     = qid ? questions[qid] : null;

  // 待機與最終排行榜跟「某一題」無關，題號與類別整個藏起來
  const onQuestion = !!q && phase !== PHASE.IDLE && phase !== PHASE.FINAL;

  badge.innerHTML = onQuestion ? `第 <b>${qIndex(qid) + 1}</b> 題` : "";
  badge.style.display = onQuestion ? "" : "none";

  const cat = categoryOf(q?.cat);
  $("#s-cat").textContent = onQuestion ? cat.name : "";
  $("#s-cat").style.setProperty("--cat", cat.color);
  $("#s-cat").style.display = onQuestion ? "" : "none";

  tip.textContent = "";

  if (phase === PHASE.FINAL)                                 return paintFinal();
  if (phase === PHASE.REVEAL && q)                           return repaintReveal();
  if ((phase === PHASE.OPEN || phase === PHASE.LOCKED) && q)  return paintPlay(qid, q, phase);
  return paintIdle();
}

function paintIdle() {
  foot.textContent = "待機中";
  body.innerHTML = `<div class="center stack">
    <img src="assets/img/hero.jpg" alt="大學星攻略" style="width:58vh; max-width:66vw; border-radius:1.4vh; margin:0 auto; box-shadow:0 0 0 .3vh rgba(255,200,31,.4), 0 2vh 6vh rgba(0,0,0,.6);">
    <p class="hint pulse" style="font-size:2.6vh; margin-top:2vh;">請用手機掃描 QR Code，選擇組別與身分 ✦</p>
  </div>`;
}

/** 題目＋倒數＋各組代表答案格 */
function paintPlay(qid, q, phase) {
  const locked = phase === PHASE.LOCKED;
  foot.textContent = locked ? "已截止作答，準備公布" : "開放作答中";

  const left = secondsLeft(state.openedAt, state.limitSec || DEFAULT_LIMIT_SEC, timeOffset);

  body.innerHTML = `
    <div style="display:flex; gap:2.4vw; align-items:center; flex:0 0 auto;">
      <div style="flex:1 1 auto; min-width:0;">
        <div class="big-q" style="font-size:3.1vh; padding:2vh 2vw;">${escapeHtml(q.text || "")}</div>
        <div class="opt-row" style="margin-top:1.4vh;">
          ${LETTERS.filter(L => q[L.toLowerCase()]).map(L =>
            `<div class="opt-mini"><span class="k">${L}</span><span>${escapeHtml(q[L.toLowerCase()])}</span></div>`
          ).join("")}
        </div>
      </div>
      <div class="countdown" id="s-countdown">${locked ? 0 : (left ?? "–")}</div>
    </div>
    <div class="grid" id="s-grid"></div>`;

  if (!locked && left !== null) paintCountdown(left);
  paintGrid(qid, false);
}

/**
 * 各組代表的答案格。
 * showRepLetters=false 時，鎖定前只顯示已確認／未確認，公布後才翻出字母。
 */
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

  el.innerHTML = gl.map(g => {
    const a = repAns[qid]?.[g.id];
    const c = LETTERS.includes(a?.c) ? a.c : null;
    const cls = ["cellbox"];
    let mark = "";

    if (c) {
      cls.push("done");
      if (revealMode && key) {
        cls.push(c === key ? "right" : "wrongc");
        mark = c === key ? "✅" : "❌";
      }
    }
    const inner = c
      ? (showLetters ? `<span class="glet">${c}</span>` : `<span class="glet">✓</span>`)
      : `<span class="waiting">···</span>`;

    return `<div class="${cls.join(" ")}">
      ${mark ? `<span class="mark">${mark}</span>` : ""}
      ${inner}
      <span class="gname">${escapeHtml(g.name)}</span>
    </div>`;
  }).join("");

  // 字級要從格子「實際拿到的高度」算 —— 出題畫面給整個下半部，
  // 公布畫面只給 26vh，用固定的 vh 公式會在公布畫面把內容切掉。
  const cellH = el.clientHeight / rows;
  const cellW = el.clientWidth  / cols;
  el.style.setProperty("--cell-let",
    Math.max(14, Math.min(cellH * 0.5, cellW * 0.42, 120)).toFixed(1) + "px");
  el.style.setProperty("--cell-name",
    Math.max(9,  Math.min(cellH * 0.2, cellW * 0.16, 24)).toFixed(1) + "px");

  const done = Object.keys(repAns[qid] || {}).length;
  if (!revealMode) tip.textContent = `${done} / ${gl.length} 組已確認`;
}

/**
 * 公布答案：正解大字與說明「同時」出現，下面接各組對錯格。
 * 全場作答分布放在第二頁（按 →），因為三樣一起塞進 16:9 會擠到看不清楚。
 */
function paintReveal(qid, q) {
  foot.textContent = "已公布答案";

  const key    = keys[qid];
  const hasImg = !!(q.exImg || "").trim();
  const text   = (q.exText || "").trim();

  body.innerHTML = `
    <div class="reveal-top">
      <div class="reveal-ans">
        <div class="title-gold" style="font-size:2.4vh;">🎉 正確答案 🎉</div>
        <div class="reveal-letter">${key || "—"}</div>
      </div>
      <div class="reveal-ex">
        <h3 class="title-gold" style="font-size:2.6vh; margin:0 0 1vh;">💡 說明</h3>
        <div class="explain ${hasImg ? "" : "noimg"}">
          <div class="txt" id="s-extext">${text ? escapeHtml(text) : "（這一題後台還沒有填說明）"}</div>
          <div class="pic">${hasImg ? `<img src="${escapeHtml(q.exImg)}" alt="說明圖片"
            onerror="this.closest('.explain').classList.add('noimg')">` : ""}</div>
        </div>
      </div>
    </div>
    <div class="grid" id="s-grid" style="flex:0 0 26vh;"></div>`;

  const t = $("#s-extext");
  fitToBox(t, t, "font-size", 2.6, 1.2);
  paintGrid(qid, true);
}

/** 補充大圖：整頁只放一張圖，適合流程圖、對照表這種要看細節的東西 */
function paintFullImage(qid, q) {
  foot.textContent = "補充說明";
  body.innerHTML = `
    <div class="fullimg">
      <img src="${escapeHtml(q.exImgFull)}" alt="補充說明大圖"
           onerror="this.parentElement.innerHTML='<p class=&quot;hint&quot; style=&quot;font-size:2.4vh&quot;>圖片載不出來，請確認後台填的網址</p>'">
    </div>`;
}

/** 全場台下學員的作答分布 */
function paintDistribution(qid, q) {
  foot.textContent = "全場作答分布";

  const key = keys[qid];
  const t   = tallyAllMembers(allResp[qid]);

  body.innerHTML = `
    <div class="big-q" style="font-size:2.6vh; padding:1.8vh 2vw; flex:0 0 auto;">${escapeHtml(q.text || "")}</div>
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
    <p class="hint center" style="font-size:1.9vh; margin:1.4vh 0 0;">
      台下學員共 ${t.total} 人作答　正解 <b style="color:var(--gold)">${key || "—"}</b>
    </p>`;
}

// ------------------------------------------------------------
//  公布階段的左右鍵：答案 ⇄ 說明
// ------------------------------------------------------------
/** 這一題公布階段有哪幾頁 —— 沒填整頁大圖就不會有那一頁 */
function revealPages(q) {
  const pages = ["answer"];
  if ((q?.exImgFull || "").trim()) pages.push("fullimg");
  pages.push("dist");
  return pages;
}

addEventListener("keydown", e => {
  if ((state.phase || "") !== PHASE.REVEAL) return;
  const q = state.qid ? questions[state.qid] : null;
  if (!q) return;
  const last = revealPages(q).length - 1;
  if (e.key === "ArrowRight") { revealPage = Math.min(last, revealPage + 1); repaintReveal(); }
  if (e.key === "ArrowLeft")  { revealPage = Math.max(0,    revealPage - 1); repaintReveal(); }
});

function repaintReveal() {
  const qid = state.qid, q = qid ? questions[qid] : null;
  if (!q) return;
  const pages = revealPages(q);
  revealPage = Math.min(revealPage, pages.length - 1);

  const painter = { answer: paintReveal, fullimg: paintFullImage, dist: paintDistribution };
  painter[pages[revealPage]](qid, q);

  // 頁尾提示要照實際頁序給，不然主持人會不知道還有沒有下一頁
  const prev = revealPage > 0 ? "← " + PAGE_NAME[pages[revealPage - 1]] : "";
  const next = revealPage < pages.length - 1 ? PAGE_NAME[pages[revealPage + 1]] + " →" : "";
  tip.textContent = [prev, next].filter(Boolean).join("　　");
}

const PAGE_NAME = {
  answer:  "答案與說明",
  fullimg: "補充大圖",
  dist:    "全場作答分布"
};

// ------------------------------------------------------------
//  最終畫面
// ------------------------------------------------------------
function scoreboardNow() {
  return buildScoreboard(groups, questions, keys, allResp, repAns, state.revealed, LISTS.MAIN);
}

function paintFinal() {
  if (finalView === "matrix") return paintMatrixScreen();

  foot.textContent = "最終排行榜";
  tip.textContent  = "按空白鍵切換到類別分析 →";

  const rows = board?.rows || scoreboardNow().rows;
  body.innerHTML = `
    <h2 class="title-gold center" style="font-size:5vh; margin:0 0 1.6vh;">★ 最終排行榜 ★</h2>
    <div class="card" style="overflow:hidden;">
      <table class="rank rank-screen">
        <thead><tr>
          <th style="width:8vh;">#</th><th>組別</th>
          <th class="n">總分</th><th class="n">代表答對</th><th class="n">學員過半</th>
        </tr></thead>
        <tbody>${
          rows.length
            ? rows.map((r, i) => `<tr class="${i === 0 ? "top1" : ""}">
                <td>${i === 0 ? "🏆" : i + 1}</td>
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
  fitToBox(t, t.parentElement, "--rfs", 2.8);
}

/** 組別 × 類別 得分矩陣 */
function paintMatrixScreen() {
  foot.textContent = "類別分析";
  tip.textContent  = "← 按空白鍵切回排行榜";

  const mx = categoryMatrix(scoreboardNow());
  if (!mx.cats.length || !mx.rows.length) {
    body.innerHTML = `<p class="hint center" style="font-size:2.6vh;">還沒有已公布的正式題目</p>`;
    return;
  }

  const wins    = columnWinners(mx);
  const bestOf  = groupBestCategories(mx);
  const bestIdx = new Map(bestOf.map(b => [b.gid, b.cat ? mx.cats.findIndex(c => c.id === b.cat.id) : -1]));

  body.innerHTML = `
    <h2 class="title-gold center" style="font-size:4.2vh; margin:0 0 1.2vh;">各組強項分析</h2>
    <p class="hint center" style="font-size:1.85vh; margin:0 0 1.4vh;">
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
  fitToBox(t, t.parentElement, "--mfs", 2.2);
}
