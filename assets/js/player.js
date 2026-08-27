// ============================================================
//  玩家端 —— 手機直式
//  分兩種身分：上台代表（一組一位，決定最終答案）與台下學員。
// ============================================================

import {
  db, auth, ref, onValue, get, set, remove, serverTimestamp, ensureAnonAuth,
  PATH, PHASE, ROLE, LETTERS, LISTS, DEFAULT_LIMIT_SEC,
  categoryOf, listOf, questionsOf, tallyMembers, scoreOne, secondsLeft, ptsOf,
  $, show, toast, toSortedList, escapeHtml
} from "./common.js";

const scr = {
  group:    $("#scr-group"),
  role:     $("#scr-role"),
  wait:     $("#scr-wait"),
  question: $("#scr-question"),
  reveal:   $("#scr-reveal"),
  final:    $("#scr-final"),
  error:    $("#scr-error")
};

let uid       = null;
let groups    = {};
let questions = {};
let state     = null;
let reps      = {};      // /reps —— 哪些組已經有代表了
let doubles   = {};      // /doubles —— 哪一題哪一組分數加倍
let timeOffset = 0;      // 伺服器時鐘差

let myGroup = localStorage.getItem("cdf_group") || "";
let myRole  = localStorage.getItem("cdf_role")  || "";

let renderedQid = null;
let revealedQid = null;
let pending     = null;   // 代表按了選項但還沒確認的字母

// 學員自己的選擇存本機。/responses 學員讀不回來（規則只放行本組代表），
// 所以重新整理後要靠這裡記得自己選了什麼。
const myPick    = qid => localStorage.getItem("cdf_pick_" + qid) || null;
const setMyPick = (qid, c) => localStorage.setItem("cdf_pick_" + qid, c);

let repsLoaded = false;   // /reps 至少同步過一次，才能判斷代表位子有沒有被收回
let unsubMembers = null;  // 代表監聽自己組的作答
let unsubKey = null, unsubRepAns = null, unsubMyRepAns = null, unsubRevMembers = null;
let memberTallyNow = { A:0, B:0, C:0, D:0, total:0 };
let myRepAnswer = null;
let tickTimer = null;

function goto(name) {
  for (const [k, el] of Object.entries(scr)) show(el, k === name);
  show($("#idbar"), !!(myGroup && myRole) && name !== "group" && name !== "role");
  // 代表的整頁換成紅底 —— 跟投影規則頁畫的那支手機同一套樣式
  document.body.classList.toggle("rep-theme", isRep());
}

function fail(err) {
  console.error(err);
  $("#err-msg").textContent =
    "無法連上伺服器（" + (err?.code || err?.message || "unknown") + "）。請確認網路，或通知工作人員。";
  goto("error");
}

// ------------------------------------------------------------
//  啟動：先匿名登入，才有身分可以寫資料、代表才讀得到學員作答
// ------------------------------------------------------------
(async function boot() {
  goto(myGroup && myRole ? "wait" : "group");
  try {
    const user = await ensureAnonAuth();
    uid = user.uid;
  } catch (e) {
    if (e?.code === "auth/operation-not-allowed" || e?.code === "auth/admin-restricted-operation") {
      $("#err-msg").textContent =
        "Firebase 尚未啟用「匿名」登入方式。請到 Firebase 主控台 → Authentication → 登入方式 啟用匿名登入。";
    } else {
      $("#err-msg").textContent = "無法建立連線（" + (e?.code || e?.message) + "）。";
    }
    goto("error");
    return;
  }
  attach();
})();

function attach() {
  onValue(ref(db, "/.info/serverTimeOffset"), s => { timeOffset = s.val() || 0; });
  onValue(ref(db, PATH.groups),    s => { groups    = s.val() || {}; paintGroupSelect(); render(); }, fail);
  onValue(ref(db, PATH.questions), s => { questions = s.val() || {}; render(); }, fail);
  onValue(ref(db, PATH.reps),      s => { reps = s.val() || {}; repsLoaded = true; paintRolePicker(); render(); }, fail);
  onValue(ref(db, PATH.doubles),   s => { doubles   = s.val() || {}; render(); }, fail);
  onValue(ref(db, PATH.state),     s => { state     = s.val() || {}; render(); }, fail);
}

// ------------------------------------------------------------
//  第一步：選組別
// ------------------------------------------------------------
const selGroup = $("#sel-group");

function paintGroupSelect() {
  const list = toSortedList(groups);
  const inProgress = selGroup.value;      // 只保留「這次」已經選的，不從 localStorage 帶
  selGroup.innerHTML = list.length
    ? '<option value="">— 請選擇 —</option>' +
      list.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join("")
    : '<option value="">（後台尚未建立組別）</option>';
  // 刻意不預先選好 —— 一定要學員自己挑，避免整組人不小心都留在第一組
  selGroup.value = groups[inProgress] ? inProgress : "";
  $("#btn-group-next").disabled = !selGroup.value;
}

selGroup.addEventListener("change", () => { $("#btn-group-next").disabled = !selGroup.value; });

$("#btn-group-next").addEventListener("click", () => {
  if (!selGroup.value) return;
  myGroup = selGroup.value;
  localStorage.setItem("cdf_group", myGroup);
  $("#role-group").textContent = groups[myGroup]?.name || "";
  paintRolePicker();
  goto("role");
});

$("#btn-role-back").addEventListener("click", () => goto("group"));

$("#btn-leave").addEventListener("click", async () => {
  if (!confirm("要重新選擇組別與身分嗎？")) return;
  // 自己是代表就把位子讓出來
  if (myRole === ROLE.REP && reps[myGroup]?.uid === uid) {
    try { await remove(ref(db, `${PATH.reps}/${myGroup}`)); } catch {}
  }
  myRole = "";
  localStorage.removeItem("cdf_role");
  goto("group");
});

// ------------------------------------------------------------
//  第二步：選身分
// ------------------------------------------------------------
function repTakenByOther() {
  const r = reps[myGroup];
  return !!r?.uid && r.uid !== uid;
}

function paintRolePicker() {
  if (!myGroup) return;
  $("#role-group").textContent = groups[myGroup]?.name || "";
  const taken = repTakenByOther();
  $("#pick-rep").classList.toggle("disabled", taken);
  $("#rep-taken").textContent = taken ? "⚠ 這組已經有代表了" : "";
}

$("#pick-rep").addEventListener("click", async () => {
  if (repTakenByOther()) { toast("這組已經有代表了"); return; }
  try {
    await set(ref(db, `${PATH.reps}/${myGroup}`), { uid, at: serverTimestamp() });
    myRole = ROLE.REP;
    localStorage.setItem("cdf_role", myRole);
    render();
  } catch (e) {
    console.error(e);
    toast("搶不到代表位置，可能剛好有人先按了");
  }
});

$("#pick-member").addEventListener("click", async () => {
  // 原本是代表又改當學員，就把位子還回去
  if (reps[myGroup]?.uid === uid) {
    try { await remove(ref(db, `${PATH.reps}/${myGroup}`)); } catch {}
  }
  myRole = ROLE.MEMBER;
  localStorage.setItem("cdf_role", myRole);
  render();
});

// ------------------------------------------------------------
//  主畫面切換
// ------------------------------------------------------------
// 函式宣告而非 const —— goto() 在 boot 階段就會呼叫它，箭頭函式會踩到 TDZ
function isRep() { return myRole === ROLE.REP; }

function paintIdBar() {
  $("#id-group").textContent = groups[myGroup]?.name || "—";
  const r = $("#id-role");
  r.textContent = isRep() ? "🎤 上台代表" : "📱 台下學員";
  r.className = isRep() ? "pill live" : "pill";
}

/** 題目在「當前題庫」中的序號 */
function questionNo(qid) {
  const list = questionsOf(questions, state?.list || LISTS.MAIN);
  const i = list.findIndex(q => q.id === qid);
  return i < 0 ? "?" : i + 1;
}

function render() {
  if (!state || !uid) return;
  if (!myGroup || !groups[myGroup]) { goto("group"); return; }
  if (!myRole) { paintRolePicker(); goto("role"); return; }

  // 代表位置被主持人釋放、或被別人接手 → 退回選身分
  // （要等 /reps 同步過一次才判斷，否則剛載入時會被自己誤踢）
  if (isRep() && repsLoaded && reps[myGroup]?.uid !== uid) {
    myRole = "";
    localStorage.removeItem("cdf_role");
    toast("你的代表身分已被取消，請重新選擇");
    paintRolePicker();
    goto("role");
    return;
  }

  paintIdBar();

  const phase = state.phase || PHASE.IDLE;
  const qid   = state.qid || null;
  const q     = qid ? questions[qid] : null;

  if (phase !== PHASE.REVEAL || qid !== revealedQid) detachReveal();
  if (phase !== PHASE.OPEN && phase !== PHASE.LOCKED) detachLive();

  if (phase === PHASE.FINAL) { renderFinal(); return; }
  if ((phase === PHASE.OPEN || phase === PHASE.LOCKED) && q) { renderQuestion(qid, q, phase); return; }
  if (phase === PHASE.REVEAL && q) { renderReveal(qid, q); return; }

  $("#wait-msg").textContent = phase === PHASE.IDLE
    ? "請把手機拿好，題目馬上就來 ✦"
    : "等待主持人操作…";
  show($("#wait-double"), state.pendingDouble === myGroup);
  goto("wait");
}

// ------------------------------------------------------------
//  作答畫面
// ------------------------------------------------------------
function detachLive() {
  if (unsubMembers)  { unsubMembers();  unsubMembers = null; }
  if (unsubMyRepAns) { unsubMyRepAns(); unsubMyRepAns = null; }
  if (tickTimer)     { clearInterval(tickTimer); tickTimer = null; }
  memberTallyNow = { A:0, B:0, C:0, D:0, total:0 };
  myRepAnswer = null;
}

function renderQuestion(qid, q, phase) {
  const locked = phase === PHASE.LOCKED;

  if (renderedQid !== qid) {
    renderedQid = qid;
    pending = null;
    $("#q-no").textContent   = questionNo(qid);
    $("#q-text").textContent = q.text || "";
    paintCatPill($("#q-cat"), q);

    const pts = ptsOf(q);
    $("#q-pts").textContent = "+" + pts;
    $("#q-pts").style.display = pts !== 1 ? "" : "none";
    $("#q-x2").style.display = doubles[qid] === myGroup ? "" : "none";

    const box = $("#opts");
    box.innerHTML = "";
    for (const L of LETTERS) {
      const label = q[L.toLowerCase()];
      if (!label) continue;
      const btn = document.createElement("button");
      btn.className = "opt";
      btn.dataset.letter = L;
      btn.innerHTML = `<span class="letter">${L}</span><span class="label">${escapeHtml(label)}</span>`;
      btn.addEventListener("click", () => pick(qid, L));
      box.appendChild(btn);
    }

    detachLive();

    if (isRep()) {
      // 代表：看自己這一組的即時選擇比例（規則只放行「你是這組代表」）
      unsubMembers = onValue(ref(db, `${PATH.responses}/${qid}/${myGroup}`), s => {
        memberTallyNow = tallyMembers(s.val());
        paintRepPanel(q);
      }, () => { /* 沒權限或還沒人作答 */ });

      unsubMyRepAns = onValue(ref(db, `${PATH.repAnswers}/${qid}/${myGroup}`), s => {
        myRepAnswer = s.val();
        paintButtons(qid, locked);
      }, () => {});
    }

    startCountdown();
  }

  show($("#rep-panel"),       isRep());
  show($("#rep-confirm-box"), isRep() && !locked);
  paintRepPanel(q);
  paintButtons(qid, locked);

  show($("#tag-open"), !locked);
  show($("#tag-lock"), locked);

  goto("question");
}

function paintButtons(qid, locked) {
  const confirmedLetter = myRepAnswer?.c || null;
  const mine = isRep() ? (confirmedLetter || pending) : myPick(qid);

  for (const btn of $("#opts").children) {
    const L = btn.dataset.letter;
    btn.classList.toggle("picked", L === mine);
    btn.classList.toggle("confirmed", !!confirmedLetter && L === confirmedLetter);
    btn.disabled = locked || !!confirmedLetter;
  }

  if (isRep()) {
    const b = $("#btn-confirm");
    b.disabled = locked || !!confirmedLetter || !pending;
    b.innerHTML = confirmedLetter
      ? `已送出 <b>${confirmedLetter}</b>`
      : `確認送出 <b>${pending || "—"}</b>`;
    $("#q-hint").textContent = confirmedLetter
      ? `已送出 ${confirmedLetter}，等待主持人公布答案。`
      : locked ? "已截止作答。"
      : "先看學員的比例，再選一個選項並按確認送出。";
  } else {
    $("#q-hint").textContent = locked
      ? (mine ? `已截止，你選的是 ${mine}。` : "已截止作答，這題你沒有作答。")
      : (mine ? `已送出 ${mine}，截止前都可以改。你的選擇會即時傳給代表。` : "選出你認為的答案，代表看得到全組的比例。");
  }
}

function paintRepPanel(q) {
  if (!isRep()) return;
  const t = memberTallyNow;
  $("#rep-count").textContent = t.total + " 人已選";
  $("#rep-bars").innerHTML = LETTERS
    .filter(L => q[L.toLowerCase()])
    .map(L => {
      const n = t[L], pct = t.total ? Math.round(n / t.total * 100) : 0;
      return `<div class="bar-row">
        <span class="bar-key">${L}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
        <span class="bar-num">${pct}%（${n}）</span>
      </div>`;
    }).join("");
}

async function pick(qid, letter) {
  if ((state?.phase || "") !== PHASE.OPEN || state?.qid !== qid) { toast("已截止作答"); return; }

  if (isRep()) {
    if (myRepAnswer?.c) { toast("已經送出，不能更改"); return; }
    pending = letter;                    // 代表只是先選，要按確認才算
    paintButtons(qid, false);
    return;
  }

  try {
    await set(ref(db, `${PATH.responses}/${qid}/${myGroup}/${uid}`), { c: letter, t: serverTimestamp() });
    setMyPick(qid, letter);
    paintButtons(qid, false);
    toast("已送出 " + letter);
  } catch (e) {
    console.error(e);
    toast("送出失敗，請再按一次");
  }
}

$("#btn-confirm").addEventListener("click", async () => {
  const qid = state?.qid;
  if (!isRep() || !qid || !pending) return;
  if (myRepAnswer?.c) { toast("已經送出了"); return; }
  if (state?.phase !== PHASE.OPEN) { toast("已截止作答"); return; }

  try {
    await set(ref(db, `${PATH.repAnswers}/${qid}/${myGroup}`), {
      c: pending, uid, t: serverTimestamp()
    });
    toast("已送出 " + pending);
  } catch (e) {
    console.error(e);
    toast("送出失敗：可能已截止或你不是這組代表");
  }
});

// ---------- 倒數 ----------
function startCountdown() {
  if (tickTimer) clearInterval(tickTimer);
  const paint = () => {
    const left = secondsLeft(state?.openedAt, state?.limitSec || DEFAULT_LIMIT_SEC, timeOffset);
    const el = $("#q-timer");
    if (left === null || state?.phase !== PHASE.OPEN) {
      el.textContent = state?.phase === PHASE.LOCKED ? "0" : "–";
      el.className = "timer";
      return;
    }
    el.textContent = left;
    el.className = "timer" + (left <= 5 ? " danger" : left <= 10 ? " warn" : "");
  };
  paint();
  tickTimer = setInterval(paint, 250);
}

// ------------------------------------------------------------
//  公布答案
// ------------------------------------------------------------
function paintCatPill(el, q) {
  const cat = categoryOf(q?.cat);
  el.textContent = cat.name;
  el.style.setProperty("--cat", cat.color);
  el.parentElement.style.display = q?.cat ? "" : "none";
}

function detachReveal() {
  if (unsubKey)        { unsubKey();        unsubKey = null; }
  if (unsubRepAns)     { unsubRepAns();     unsubRepAns = null; }
  if (unsubRevMembers) { unsubRevMembers(); unsubRevMembers = null; }
  revealedQid = null;
}

function renderReveal(qid, q) {
  goto("reveal");
  if (revealedQid === qid) return;
  revealedQid = qid;

  $("#r-no").textContent = questionNo(qid);
  paintCatPill($("#r-cat"), q);

  let key = null, repAns = null, members = null;

  const repaint = () => {
    $("#r-letter").textContent = key || "—";
    // 字母下面補上該選項的文字，跟投影幕一致
    $("#r-opt").textContent = key ? (q[String(key).toLowerCase()] || "").trim() : "";

    const s = scoreOne(key, repAns, members,
      doubles[qid] === myGroup ? ptsOf(q) * 2 : ptsOf(q));
    const v = $("#r-verdict");
    if (!repAns)          { v.className = "verdict";     v.textContent = "你們這組代表沒有作答"; }
    else if (s.repOk)     { v.className = "verdict ok";  v.textContent = `代表答對了！選 ${s.repChoice}`; }
    else                  { v.className = "verdict bad"; v.textContent = `代表選了 ${s.repChoice}`; }

    $("#r-points").textContent = `本題 +${s.points} 分`
      + (doubles[qid] === myGroup ? "（轉盤 ×2）" : "");

    const t = s.memberTally;
    $("#r-bars").innerHTML = LETTERS
      .filter(L => q[L.toLowerCase()])
      .map(L => {
        const n = t[L], pct = t.total ? Math.round(n / t.total * 100) : 0;
        return `<div class="bar-row">
          <span class="bar-key">${L}</span>
          <span class="bar-track"><span class="bar-fill${L === key ? " is-correct" : ""}" style="width:${pct}%"></span></span>
          <span class="bar-num">${pct}%（${n}）</span>
        </div>`;
      }).join("");

    $("#r-detail").innerHTML = [
      `代表：${s.repChoice || "未作答"} ${s.repOk ? "✅ +1" : "❌"}`,
      s.memberRate === null
        ? "學員：沒有人作答"
        : `學員答對率：${s.memberRate}%（${s.memberCorrect}/${t.total}）${s.memberOk ? "✅ 過半 +1" : "❌ 未過半"}`
    ].join("<br>");
  };

  repaint();

  // 正解：安全性規則規定「已公布」才讀得到
  unsubKey = onValue(ref(db, `${PATH.answerKey}/${qid}`), s => { key = s.val(); repaint(); }, () => {});
  unsubRepAns = onValue(ref(db, `${PATH.repAnswers}/${qid}/${myGroup}`), s => { repAns = s.val(); repaint(); }, () => {});
  // 學員分布：代表讀得到即時資料；學員讀不到，就只顯示自己的部分
  if (isRep()) {
    unsubRevMembers = onValue(ref(db, `${PATH.responses}/${qid}/${myGroup}`),
      s => { members = s.val(); repaint(); }, () => {});
  } else {
    const mine = myPick(qid);
    members = mine ? { [uid]: { c: mine } } : null;
    repaint();
  }
}

// ------------------------------------------------------------
//  最終排行榜
// ------------------------------------------------------------
async function renderFinal() {
  goto("final");
  try {
    const snap = await get(ref(db, PATH.leaderboard));
    const rows = snap.val()?.rows || [];
    // 跟投影幕一致：只公布前三名
    const top = rows.slice(0, 3);
    const mineIdx = rows.findIndex(r => r.gid === myGroup);

    $("#final-rows").innerHTML = top.length
      ? top.map((r, i) => `<tr class="${i === 0 ? "top1" : ""}">
          <td>${["🥇", "🥈", "🥉"][i]}</td>
          <td>${escapeHtml(r.name)}${r.gid === myGroup ? " ←" : ""}</td>
          <td class="n">${r.points}</td>
          <td class="n">${r.repCorrect}</td>
          <td class="n">${r.memberBonus}</td>
        </tr>`).join("")
      : `<tr><td colspan="5" style="color:#a9bce8;">主持人尚未產生排行榜</td></tr>`;

    // 自己這組沒進前三，就單獨補一行讓他們知道名次
    if (mineIdx >= 3) {
      const r = rows[mineIdx];
      $("#final-rows").insertAdjacentHTML("beforeend",
        `<tr><td colspan="5" style="color:#5f6f9c; text-align:center; padding:4px;">⋯</td></tr>
         <tr><td>${mineIdx + 1}</td>
           <td>${escapeHtml(r.name)} ←</td>
           <td class="n">${r.points}</td>
           <td class="n">${r.repCorrect}</td>
           <td class="n">${r.memberBonus}</td></tr>`);
    }

    const mine = rows.find(r => r.gid === myGroup);
    if (mine?.bestCat) {
      const cat = categoryOf(mine.bestCat);
      $("#final-cat").textContent = cat.name;
      $("#final-cat").style.setProperty("--cat", cat.color);
      $("#final-cat-note").textContent = `這個項目拿到 ${mine.bestCatPoints} / ${mine.bestCatMax} 分`;
      show($("#final-mine"), true);
    } else {
      show($("#final-mine"), false);
    }
  } catch {
    $("#final-rows").innerHTML = `<tr><td colspan="5" style="color:#a9bce8;">讀取排行榜失敗</td></tr>`;
    show($("#final-mine"), false);
  }
}
