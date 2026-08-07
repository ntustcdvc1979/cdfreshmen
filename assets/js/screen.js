// ============================================================
//  投影統計頁 —— 主持人切到瀏覽器全螢幕給觀眾看
//  需要主持人身分（統計資料只有登入後讀得到）。
//  在同一個瀏覽器開過 host.html 登入後，這頁會自動沿用登入狀態。
// ============================================================

import {
  db, auth, ref, onValue, onAuthStateChanged,
  PATH, PHASE, LETTERS, categoryOf, $, escapeHtml, toSortedList, isHost,
  tallyQuestion, buildLeaderboard, buildCategoryMatrix, groupBestCategories, columnWinners
} from "./common.js";

let groups = {}, questions = {}, keys = {}, allResp = {}, state = {}, board = null;
let ready = false;

const body  = $("#s-body");
const badge = $("#s-badge");
const foot  = $("#s-phase");
const tip   = $("#s-tip");

// 結束畫面在「排行榜」與「類別分析」之間切換（按空白鍵、方向鍵或點畫面）
let finalView = "rank";
function toggleFinalView() {
  if ((state.phase || "") !== PHASE.FINAL) return;
  finalView = finalView === "rank" ? "matrix" : "rank";
  paint();
}
addEventListener("keydown", e => {
  if ([" ", "ArrowRight", "ArrowLeft", "Enter"].includes(e.key)) { e.preventDefault(); toggleFinalView(); }
});
addEventListener("click", toggleFinalView);

onAuthStateChanged(auth, async user => {
  if (!await isHost(user)) {
    body.innerHTML = `<div class="card center stack" style="max-width:60vw; margin:0 auto;">
      <h2 class="title-gold" style="font-size:4vh; margin:0;">尚未登入</h2>
      <p class="hint" style="font-size:2.2vh;">請先在同一個瀏覽器開啟
        <a href="host.html" style="color:var(--gold-lt)">主持人控制台</a> 登入，再回到這一頁。</p>
    </div>`;
    return;
  }
  if (ready) return;
  ready = true;
  onValue(ref(db, PATH.groups),      s => { groups    = s.val() || {}; paint(); });
  onValue(ref(db, PATH.questions),   s => { questions = s.val() || {}; paint(); });
  onValue(ref(db, PATH.answerKey),   s => { keys      = s.val() || {}; paint(); });
  onValue(ref(db, PATH.responses),   s => { allResp   = s.val() || {}; paint(); });
  onValue(ref(db, PATH.leaderboard), s => { board     = s.val();        paint(); });
  onValue(ref(db, PATH.state),       s => { state     = s.val() || {}; paint(); });
});

/**
 * 把表格字級縮到剛好塞得下容器。
 * 組別數、類別數、投影機比例都會變，用算的猜不準，直接量。
 */
function fitToBox(table, box, prop, startVh, minVh = 0.8) {
  let vh = startVh;
  table.style.setProperty(prop, vh.toFixed(2) + "vh");
  for (let i = 0; i < 40 && vh > minVh; i++) {
    if (box.scrollHeight <= box.clientHeight + 1) break;
    vh = Math.max(minVh, vh - 0.08);
    table.style.setProperty(prop, vh.toFixed(2) + "vh");
  }
}

const qList  = () => toSortedList(questions);
const qIndex = qid => qList().findIndex(q => q.id === qid);

function paint() {
  if (!ready) return;
  const phase = state.phase || PHASE.IDLE;
  const qid   = state.qid || null;
  const q     = qid ? questions[qid] : null;
  const key   = qid ? keys[qid] : null;
  const tally = tallyQuestion(qid ? allResp[qid] : null, key);

  badge.innerHTML = q ? `第 <b>${qIndex(qid) + 1}</b> 題` : `第 <b>–</b> 題`;

  const cat = categoryOf(q?.cat);
  $("#s-cat").textContent = q ? cat.name : "—";
  $("#s-cat").style.setProperty("--cat", cat.color);
  $("#s-cat").style.visibility = q ? "visible" : "hidden";

  tip.textContent = "";

  if (phase === PHASE.FINAL)                       return paintFinal();
  if (phase === PHASE.REVEAL && q)                 return paintReveal(q, key, tally);
  if ((phase === PHASE.OPEN || phase === PHASE.LOCKED) && q) return paintQuestion(q, tally, phase);
  return paintIdle();
}

function paintIdle() {
  foot.textContent = "待機中";
  body.innerHTML = `<div class="center stack">
    <img src="assets/img/hero.jpg" alt="大學星攻略" style="width:64vh; max-width:70vw; border-radius:1.4vh; margin:0 auto; box-shadow:0 0 0 .3vh rgba(255,200,31,.4), 0 2vh 6vh rgba(0,0,0,.6);">
    <p class="hint pulse" style="font-size:2.8vh; margin-top:2vh;">請用手機掃描 QR Code 選擇組別 ✦</p>
  </div>`;
}

function paintQuestion(q, tally, phase) {
  foot.textContent = phase === PHASE.OPEN ? "開放作答中" : "已截止作答，準備公布";
  body.innerHTML = `
    <div class="big-q">${escapeHtml(q.text || "")}</div>
    <div class="counter">
      <div class="n title-gold">${tally.total}</div>
      <div class="cap">${phase === PHASE.OPEN ? "人已經作答" : "人完成作答"}</div>
    </div>`;
}

function paintReveal(q, key, tally) {
  foot.textContent = "已公布答案";
  const rows = LETTERS.filter(L => q[L.toLowerCase()]).map(L => {
    const n = tally[L], pct = tally.total ? Math.round(n / tally.total * 100) : 0;
    return `<div class="bar-row">
      <span class="bar-key">${L}</span>
      <span class="bar-opt">${escapeHtml(q[L.toLowerCase()])}</span>
      <span class="bar-track"><span class="bar-fill${L === key ? " is-correct" : ""}" style="width:${pct}%"></span></span>
      <span class="bar-num">${n} 人（${pct}%）</span>
    </div>`;
  }).join("");

  body.innerHTML = `
    <div style="display:flex; gap:3vw; align-items:center; min-height:0;">
      <div style="flex:0 0 34%; text-align:center;">
        <div class="title-gold" style="font-size:3.4vh;">🎉 正確答案 🎉</div>
        <div class="reveal-letter huge-letter">${key || "—"}</div>
      </div>
      <div style="flex:1 1 auto; min-width:0;">
        <div class="big-q" style="font-size:2.8vh; padding:2vh 2vw; margin-bottom:2.4vh;">${escapeHtml(q.text || "")}</div>
        <div class="bars screen-bars">${rows}</div>
      </div>
    </div>`;
}

function paintFinal() {
  if (finalView === "matrix") return paintMatrixScreen();

  foot.textContent = "最終排行榜";
  tip.textContent  = "按空白鍵切換到類別分析 →";
  const rows = board?.rows || buildLeaderboard(groups, questions, keys, allResp, state.revealed);
  body.innerHTML = `
    <h2 class="title-gold center" style="font-size:5.4vh; margin:0 0 2vh;">★ 最終排行榜 ★</h2>
    <div class="card" style="overflow:hidden;">
      <table class="rank rank-screen">
        <thead><tr><th style="width:8vh;">#</th><th>組別</th><th class="n">答對率</th><th class="n">答對／作答</th></tr></thead>
        <tbody>${
          rows.length
            ? rows.map((r, i) => `<tr class="${i === 0 ? "top1" : ""}">
                <td>${i === 0 ? "🏆" : i + 1}</td>
                <td>${escapeHtml(r.name)}</td>
                <td class="n">${r.rate}%</td>
                <td class="n">${r.correct} / ${r.answered}</td>
              </tr>`).join("")
            : `<tr><td colspan="4" class="hint">尚無資料</td></tr>`
        }</tbody>
      </table>
    </div>`;
  fitToBox($(".rank-screen"), $(".rank-screen").parentElement, "--rfs", 2.8);
}

/** 組別 × 類別 矩陣：一張表同時回答「哪組擅長這個類別」和「這組擅長哪個類別」 */
function paintMatrixScreen() {
  foot.textContent = "類別分析";
  tip.textContent  = "← 按空白鍵切回排行榜";

  const mx = buildCategoryMatrix(groups, questions, keys, allResp, state.revealed);
  if (!mx.cats.length || !mx.rows.length) {
    body.innerHTML = `<p class="hint center" style="font-size:2.6vh;">還沒有已公布的題目</p>`;
    return;
  }

  const wins    = columnWinners(mx);
  const bestOf  = groupBestCategories(mx);
  const bestIdx = new Map(bestOf.map(b => [b.gid, b.cat ? mx.cats.findIndex(c => c.id === b.cat.id) : -1]));

  body.innerHTML = `
    <h2 class="title-gold center" style="font-size:4.4vh; margin:0 0 1.4vh;">各組強項分析</h2>
    <p class="hint center" style="font-size:1.9vh; margin:0 0 1.6vh;">
      數字為答對率　<b style="color:var(--gold)">金色</b>＝該類別最強的組
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
                cell.rate === null ? "–" : `${cell.rate}%<small>${cell.correct}/${cell.answered}</small>`
              }</td>`;
            }).join("")}
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  fitToBox($(".matrix-screen"), $(".matrix-screen").parentElement, "--mfs", 2.2);
}
