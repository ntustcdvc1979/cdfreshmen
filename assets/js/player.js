// ============================================================
//  玩家端 —— 手機直式
// ============================================================

import {
  db, ref, onValue, get, set, serverTimestamp,
  PATH, PHASE, LETTERS, clientId, $, show, toast, toSortedList, escapeHtml
} from "./common.js";

const me = clientId();

const scr = {
  group:    $("#scr-group"),
  wait:     $("#scr-wait"),
  question: $("#scr-question"),
  reveal:   $("#scr-reveal"),
  final:    $("#scr-final"),
  error:    $("#scr-error")
};

let groups     = {};      // 組別
let questions  = {};      // 題目（不含正解）
let state      = null;    // 主持人的當前狀態
let myGroup    = localStorage.getItem("cdf_group") || "";
let renderedQid = null;   // 已經畫過的題目，避免重畫時閃爍
let revealedQid = null;   // 目前正在公布的題目
let keyUnsub   = null;    // /answerKey/{qid} 的監聽解除函式
let statsUnsub = null;
let lastStats  = null;    // /stats/{qid} 最新內容

/** 只顯示其中一個畫面 */
function goto(name) {
  for (const [k, el] of Object.entries(scr)) show(el, k === name);
}

/** 我在這題選了什麼（存本機，因為 /responses 只有主持人讀得到） */
const myPick = {
  get: qid => localStorage.getItem("cdf_ans_" + qid) || null,
  set: (qid, c) => localStorage.setItem("cdf_ans_" + qid, c)
};

// ------------------------------------------------------------
//  組別
// ------------------------------------------------------------
const sel = $("#sel-group");
const btnJoin = $("#btn-join");

onValue(ref(db, PATH.groups), snap => {
  groups = snap.val() || {};
  const list = toSortedList(groups);

  sel.innerHTML = list.length
    ? '<option value="">— 請選擇 —</option>' +
      list.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join("")
    : '<option value="">（後台尚未建立組別）</option>';

  if (myGroup && groups[myGroup]) sel.value = myGroup;
  btnJoin.disabled = !sel.value;
  paintGroupPill();
}, err => fail(err));

sel.addEventListener("change", () => { btnJoin.disabled = !sel.value; });

btnJoin.addEventListener("click", () => {
  if (!sel.value) return;
  myGroup = sel.value;
  localStorage.setItem("cdf_group", myGroup);
  paintGroupPill();
  render();
});

$("#btn-regroup").addEventListener("click", () => {
  myGroup = "";
  localStorage.removeItem("cdf_group");
  goto("group");
});

function paintGroupPill() {
  $("#wait-group").textContent = myGroup && groups[myGroup] ? "你的組別：" + groups[myGroup].name : "尚未選組";
}

// ------------------------------------------------------------
//  題目 & 狀態
// ------------------------------------------------------------
onValue(ref(db, PATH.questions), snap => { questions = snap.val() || {}; render(); }, fail);
onValue(ref(db, PATH.state),     snap => { state     = snap.val() || {};  render(); }, fail);

function fail(err) {
  console.error(err);
  $("#err-msg").textContent = "無法連上伺服器（" + (err?.code || err?.message || "unknown") + "）。請確認網路，或通知工作人員。";
  goto("error");
}

/** 題目在整份題庫中的序號（第幾題） */
function questionNo(qid) {
  const list = toSortedList(questions);
  const i = list.findIndex(q => q.id === qid);
  return i < 0 ? "?" : i + 1;
}

function render() {
  if (!state) return;                      // 還沒拿到狀態
  if (!myGroup || !groups[myGroup]) { goto("group"); return; }

  const phase = state.phase || PHASE.IDLE;
  const qid   = state.qid || null;
  const q     = qid ? questions[qid] : null;

  if (phase !== PHASE.REVEAL || qid !== revealedQid) detachReveal();

  if (phase === PHASE.FINAL) { renderFinal(); return; }

  if ((phase === PHASE.OPEN || phase === PHASE.LOCKED) && q) { renderQuestion(qid, q, phase); return; }

  if (phase === PHASE.REVEAL && q) { renderReveal(qid, q); return; }

  $("#wait-msg").textContent = phase === PHASE.IDLE
    ? "請把手機拿好，題目馬上就來 ✦"
    : "等待主持人操作…";
  goto("wait");
}

// ------------------------------------------------------------
//  作答畫面
// ------------------------------------------------------------
function renderQuestion(qid, q, phase) {
  const locked = phase === PHASE.LOCKED;

  if (renderedQid !== qid) {
    renderedQid = qid;
    $("#q-no").textContent   = questionNo(qid);
    $("#q-text").textContent = q.text || "";

    const box = $("#opts");
    box.innerHTML = "";
    for (const L of LETTERS) {
      const label = q[L.toLowerCase()];
      if (!label) continue;
      const btn = document.createElement("button");
      btn.className = "opt";
      btn.dataset.letter = L;
      btn.innerHTML = `<span class="letter">${L}</span><span class="label">${escapeHtml(label)}</span>`;
      btn.addEventListener("click", () => submit(qid, L));
      box.appendChild(btn);
    }
  }

  const picked = myPick.get(qid);
  for (const btn of $("#opts").children) {
    btn.classList.toggle("picked", btn.dataset.letter === picked);
    btn.disabled = locked;
  }

  show($("#tag-open"), !locked);
  show($("#tag-lock"), locked);
  $("#q-hint").textContent = locked
    ? (picked ? `已截止，你的答案是 ${picked}。等待主持人公布…` : "已截止作答，這題沒有送出答案。")
    : (picked ? `已送出 ${picked}，截止前都可以改。` : "選好之後就送出，主持人公布前答案不會顯示。");

  goto("question");
}

async function submit(qid, letter) {
  if ((state?.phase || "") !== PHASE.OPEN || state?.qid !== qid) {
    toast("已截止作答");
    return;
  }
  try {
    await set(ref(db, `${PATH.responses}/${qid}/${me}`), {
      g: myGroup, c: letter, t: serverTimestamp()
    });
    myPick.set(qid, letter);
    render();
    toast("已送出 " + letter);
  } catch (e) {
    console.error(e);
    toast("送出失敗，請再按一次");
  }
}

// ------------------------------------------------------------
//  公布答案
// ------------------------------------------------------------
function detachReveal() {
  if (keyUnsub)   { keyUnsub();   keyUnsub = null; }
  if (statsUnsub) { statsUnsub(); statsUnsub = null; }
  revealedQid = null;
  lastStats = null;
}

function renderReveal(qid, q) {
  goto("reveal");
  if (revealedQid === qid) return;   // 已經在公布這一題，不要重跑動畫
  revealedQid = qid;
  $("#r-no").textContent = questionNo(qid);

  // 正解：資料庫規則規定「已公布」才讀得到，所以現在才掛監聽
  keyUnsub = onValue(ref(db, `${PATH.answerKey}/${qid}`), snap => {
    const key    = snap.val();
    const picked = myPick.get(qid);
    $("#r-letter").textContent = key || "—";

    const v = $("#r-verdict");
    if (!picked)          { v.className = "verdict";     v.textContent = "這題你沒有作答"; }
    else if (picked === key){ v.className = "verdict ok";  v.textContent = `答對了！你選 ${picked}`; }
    else                  { v.className = "verdict bad"; v.textContent = `可惜，你選了 ${picked}`; }

    paintBars(key, q);
  }, () => { /* 尚未開放讀取，等主持人公布 */ });

  statsUnsub = onValue(ref(db, `${PATH.stats}/${qid}`), snap => {
    lastStats = snap.val();
    paintBars(null, q);
  }, () => {});
}

function paintBars(keyMaybe, q) {
  const key   = keyMaybe ?? lastStats?.key ?? null;
  const stats = lastStats;
  const total = stats?.total || 0;

  $("#r-bars").innerHTML = LETTERS
    .filter(L => q[L.toLowerCase()])
    .map(L => {
      const n   = stats?.[L] || 0;
      const pct = total ? Math.round(n / total * 100) : 0;
      return `<div class="bar-row">
        <span class="bar-key">${L}</span>
        <span class="bar-track"><span class="bar-fill${L === key ? " is-correct" : ""}" style="width:${pct}%"></span></span>
        <span class="bar-num">${n} 人 ${pct}%</span>
      </div>`;
    }).join("");
}

// ------------------------------------------------------------
//  最終排行榜
// ------------------------------------------------------------
async function renderFinal() {
  goto("final");
  try {
    const snap = await get(ref(db, PATH.leaderboard));
    const rows = snap.val()?.rows || [];
    $("#final-rows").innerHTML = rows.length
      ? rows.map((r, i) => `<tr class="${i === 0 ? "top1" : ""}">
          <td>${i === 0 ? "🏆" : i + 1}</td>
          <td>${escapeHtml(r.name)}</td>
          <td class="n">${r.rate}%</td>
          <td class="n">${r.correct}/${r.answered}</td>
        </tr>`).join("")
      : `<tr><td colspan="4" style="color:#a9bce8;">主持人尚未產生排行榜</td></tr>`;
  } catch {
    $("#final-rows").innerHTML = `<tr><td colspan="4" style="color:#a9bce8;">讀取排行榜失敗</td></tr>`;
  }
}

// 一開始先顯示選組別，避免白畫面
goto(myGroup ? "wait" : "group");
