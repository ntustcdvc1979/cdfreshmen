// ============================================================
//  主持人控制台
// ============================================================

import {
  db, auth, ref, onValue, set, update, remove, serverTimestamp,
  signInWithGoogle, consumeRedirectResult, authErrorText, signOut, onAuthStateChanged,
  PATH, PHASE, LISTS, LIST_LABEL, LETTERS, DEFAULT_LIMIT_SEC,
  categoryOf, questionsOf, tallyAllMembers, tallyReps, scoreOne, secondsLeft,
  buildScoreboard, categoryMatrix, categoryChampions, groupBestCategories, columnWinners,
  isHost, notHostHtml, $, show, toast, toSortedList, escapeHtml
} from "./common.js";

let groups = {}, questions = {}, keys = {}, allResp = {}, repAns = {}, reps = {}, state = {};
let curQid = null, curList = LISTS.MAIN;
let booted = false, timeOffset = 0;
let autoLocked = null;      // 已經自動截止過的題目，避免重複寫入

const PHASE_LABEL = {
  [PHASE.IDLE]:   ["待機中", "pill"],
  [PHASE.OPEN]:   ["開放作答中", "pill live"],
  [PHASE.LOCKED]: ["已截止，尚未公布", "pill lock"],
  [PHASE.REVEAL]: ["已公布答案", "pill live"],
  [PHASE.FINAL]:  ["已公布排行榜", "pill live"]
};

// ------------------------------------------------------------
//  登入
// ------------------------------------------------------------
consumeRedirectResult().then(e => { if (e) $("#login-msg").textContent = authErrorText(e); });

$("#btn-login").addEventListener("click", async () => {
  $("#btn-login").disabled = true;
  $("#login-msg").textContent = "登入中…";
  try { await signInWithGoogle(); }
  catch (e) { $("#login-msg").textContent = authErrorText(e); }
  finally { $("#btn-login").disabled = false; }
});

onAuthStateChanged(auth, async user => {
  const ok = await isHost(user);
  show($("#scr-login"),   !ok);
  show($("#scr-console"),  ok);

  if (user && !ok) {
    $("#login-msg").innerHTML = notHostHtml(user);
    await signOut(auth);
    return;
  }
  if (ok) {
    $("#tag-who").textContent = user.email;
    if (!booted) { booted = true; attach(); }
  }
});

$("#btn-logout").addEventListener("click", () => signOut(auth).then(() => location.reload()));

// ------------------------------------------------------------
//  資料監聽（登入後才掛，否則會被安全性規則擋下）
// ------------------------------------------------------------
function attach() {
  onValue(ref(db, "/.info/serverTimeOffset"), s => { timeOffset = s.val() || 0; });
  onValue(ref(db, PATH.groups),     s => { groups  = s.val() || {}; paint(); });
  onValue(ref(db, PATH.answerKey),  s => { keys    = s.val() || {}; paint(); });
  onValue(ref(db, PATH.responses),  s => { allResp = s.val() || {}; paint(); });
  onValue(ref(db, PATH.repAnswers), s => { repAns  = s.val() || {}; paint(); });
  onValue(ref(db, PATH.reps),       s => { reps    = s.val() || {}; paint(); });
  onValue(ref(db, PATH.state),      s => { state   = s.val() || {}; syncFromState(); paint(); });
  onValue(ref(db, PATH.questions),  s => { questions = s.val() || {}; paintQuestionSelect(); paint(); });
  setInterval(tickTimer, 250);
}

function syncFromState() {
  if (state.list && state.list !== curList) { curList = state.list; paintQuestionSelect(); }
  if (state.qid && state.qid !== curQid) {
    curQid = state.qid;
    const opt = $("#sel-q").querySelector(`option[value="${CSS.escape(curQid)}"]`);
    if (opt) $("#sel-q").value = curQid;
  }
  $("#sel-list").value        = curList;
  $("#in-limit").value        = state.limitSec ?? DEFAULT_LIMIT_SEC;
  $("#in-cols").value         = state.gridCols ?? 0;
  $("#in-showletters").checked = state.showRepLetters !== false;
}

const qList  = () => questionsOf(questions, curList);
const qIndex = qid => qList().findIndex(q => q.id === qid);

function paintQuestionSelect() {
  const list = qList();
  $("#sel-q").innerHTML = list.length
    ? list.map((q, i) => `<option value="${escapeHtml(q.id)}">第 ${i + 1} 題　${escapeHtml((q.text || "").slice(0, 24))}</option>`).join("")
    : `<option value="">（這個題庫還沒有題目）</option>`;
  if (!list.some(q => q.id === curQid)) curQid = list[0]?.id || null;
  if (curQid) $("#sel-q").value = curQid;
}

// ------------------------------------------------------------
//  設定
// ------------------------------------------------------------
$("#sel-list").addEventListener("change", async () => {
  curList = $("#sel-list").value === LISTS.DEMO ? LISTS.DEMO : LISTS.MAIN;
  paintQuestionSelect();
  await update(ref(db, PATH.state), { list: curList, qid: curQid || null, phase: PHASE.IDLE });
  toast("已切換到 " + LIST_LABEL[curList]);
});

$("#sel-q").addEventListener("change", async () => {
  curQid = $("#sel-q").value;
  await update(ref(db, PATH.state), { qid: curQid, phase: PHASE.IDLE });
  paint();
});

$("#in-limit").addEventListener("change", async () => {
  const v = Math.max(5, Math.min(600, Number($("#in-limit").value) || DEFAULT_LIMIT_SEC));
  $("#in-limit").value = v;
  await update(ref(db, PATH.state), { limitSec: v });
});

$("#in-cols").addEventListener("change", async () => {
  const v = Math.max(0, Math.min(12, Number($("#in-cols").value) || 0));
  $("#in-cols").value = v;
  await update(ref(db, PATH.state), { gridCols: v });
});

$("#in-showletters").addEventListener("change", async () => {
  await update(ref(db, PATH.state), { showRepLetters: $("#in-showletters").checked });
});

// ------------------------------------------------------------
//  控制動作
// ------------------------------------------------------------
$("#btn-open").addEventListener("click", () => openQuestion(curQid));
$("#btn-lock").addEventListener("click", () => update(ref(db, PATH.state), { phase: PHASE.LOCKED }));
$("#btn-idle").addEventListener("click", () => update(ref(db, PATH.state), { phase: PHASE.IDLE }));
$("#btn-reveal").addEventListener("click", doReveal);
$("#btn-final").addEventListener("click", doFinal);
$("#btn-prev").addEventListener("click", () => step(-1));
$("#btn-next").addEventListener("click", () => step(+1));

async function step(dir) {
  const list = qList();
  const i = qIndex(curQid);
  const next = list[Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))];
  if (!next) return;
  if (next.id === curQid && i >= 0) { toast(dir > 0 ? "已經是最後一題" : "已經是第一題"); return; }
  await openQuestion(next.id);
}

async function openQuestion(qid) {
  if (!qid) { toast("請先選擇題目"); return; }
  curQid = qid;
  autoLocked = null;
  await update(ref(db, PATH.state), {
    qid,
    list: curList,
    phase: PHASE.OPEN,
    openedAt: serverTimestamp(),
    limitSec: Math.max(5, Number($("#in-limit").value) || DEFAULT_LIMIT_SEC)
  });
  toast("第 " + (qIndex(qid) + 1) + " 題　開始倒數");
}

/** 公布答案：先算好統計寫進 /stats，再把這題標記為已公布 */
async function doReveal() {
  const qid = curQid;
  if (!qid) return;
  const key = keys[qid];
  if (!key) { toast("這題還沒設定正解，請先到後台補上"); return; }

  await set(ref(db, `${PATH.stats}/${qid}`), {
    ...tallyAllMembers(allResp[qid]),
    key,
    rep: tallyReps(repAns[qid])
  });
  await update(ref(db, PATH.state), { phase: PHASE.REVEAL, qid, [`revealed/${qid}`]: true });
  toast("已公布答案：" + key);
}

/** 結束：算出排行榜寫進 /leaderboard，學生端就能看到 */
async function doFinal() {
  if (!confirm("要結束遊戲並公布最終排行榜嗎？")) return;

  const board = buildScoreboard(groups, questions, keys, allResp, repAns, state.revealed, LISTS.MAIN);
  const best  = new Map(groupBestCategories(categoryMatrix(board)).map(b => [b.gid, b]));

  const rows = board.rows.map(r => {
    const b = best.get(r.gid);
    const { byCat, ...rest } = r;      // byCat 不用送到學生端
    return b?.cat
      ? { ...rest, bestCat: b.cat.id, bestCatPoints: b.cell.points, bestCatMax: b.cell.max }
      : rest;
  });

  await set(ref(db, PATH.leaderboard), { updatedAt: Date.now(), rows });
  await update(ref(db, PATH.state), { phase: PHASE.FINAL });
  toast("排行榜已公布");
}

$("#btn-clear-q").addEventListener("click", async () => {
  const qid = curQid;
  if (!qid) return;
  if (!confirm(`清除第 ${qIndex(qid) + 1} 題的所有作答（代表答案＋組員作答），讓這題可以重來？`)) return;
  await Promise.all([
    remove(ref(db, `${PATH.repAnswers}/${qid}`)),
    remove(ref(db, `${PATH.responses}/${qid}`)),
    remove(ref(db, `${PATH.stats}/${qid}`)),
    remove(ref(db, `${PATH.state}/revealed/${qid}`))
  ]);
  await update(ref(db, PATH.state), { phase: PHASE.IDLE });
  toast("已清除本題");
});

$("#btn-reset").addEventListener("click", async () => {
  if (!confirm("確定清除「所有」作答紀錄、統計與排行榜？此動作無法復原。")) return;
  if (!confirm("再確認一次：所有人的答案都會消失。")) return;
  await Promise.all([
    remove(ref(db, PATH.responses)),
    remove(ref(db, PATH.repAnswers)),
    remove(ref(db, PATH.stats)),
    remove(ref(db, PATH.leaderboard)),
    set(ref(db, PATH.state), {
      phase: PHASE.IDLE, list: curList, qid: curQid || null, revealed: null,
      limitSec: Number($("#in-limit").value) || DEFAULT_LIMIT_SEC,
      gridCols: Number($("#in-cols").value) || 0,
      showRepLetters: $("#in-showletters").checked
    })
  ]);
  toast("已清除");
});

// ------------------------------------------------------------
//  倒數：歸零就自動截止（由控制台負責寫，投影頁只是顯示）
// ------------------------------------------------------------
function tickTimer() {
  const el = $("#tag-timer");
  const phase = state.phase || PHASE.IDLE;

  if (phase !== PHASE.OPEN) {
    el.textContent = phase === PHASE.LOCKED ? "0" : "–";
    el.className = "timer";
    return;
  }
  const left = secondsLeft(state.openedAt, state.limitSec || DEFAULT_LIMIT_SEC, timeOffset);
  el.textContent = left ?? "–";
  el.className = "timer" + (left <= 5 ? " danger" : left <= 10 ? " warn" : "");

  if (left === 0 && autoLocked !== state.qid) {
    autoLocked = state.qid;
    update(ref(db, PATH.state), { phase: PHASE.LOCKED }).catch(() => {});
  }
}

// ------------------------------------------------------------
//  畫面
// ------------------------------------------------------------
function paint() {
  const phase = state.phase || PHASE.IDLE;
  const [label, cls] = PHASE_LABEL[phase] || PHASE_LABEL[PHASE.IDLE];
  $("#tag-phase").textContent = label;
  $("#tag-phase").className   = cls;

  const qid = curQid;
  const q   = qid ? questions[qid] : null;
  const key = qid ? keys[qid] : null;

  const cat = categoryOf(q?.cat);
  $("#live-cat").textContent = q ? cat.name : "—";
  $("#live-cat").style.setProperty("--cat", cat.color);

  $("#live-q").textContent   = q ? `第 ${qIndex(qid) + 1} 題　${q.text || ""}` : "尚未選擇題目";
  $("#live-key").textContent = key || "（未設定）";

  const gl  = toSortedList(groups);
  const rt  = tallyReps(repAns[qid]);
  const mt  = tallyAllMembers(allResp[qid]);
  $("#live-count").textContent = `代表 ${rt.total}/${gl.length} 組已確認　組員 ${mt.total} 人已選`;

  $("#live-repbars").innerHTML = bars(q, rt, key, gl.length);
  $("#live-membars").innerHTML = bars(q, mt, key, mt.total);

  // 排行榜
  const board = buildScoreboard(groups, questions, keys, allResp, repAns, state.revealed, LISTS.MAIN);
  $("#rank-rows").innerHTML = board.rows.length
    ? board.rows.map((r, i) => {
        const s = scoreOne(key, repAns[qid]?.[r.gid], allResp[qid]?.[r.gid]);
        return `<tr class="${i === 0 && r.points ? "top1" : ""}">
          <td>${i + 1}</td>
          <td>${escapeHtml(r.name)}</td>
          <td class="n">${r.points}<small style="opacity:.5"> / ${r.max}</small></td>
          <td class="n">${r.repCorrect}</td>
          <td class="n">${r.memberBonus}</td>
          <td class="n">${s.repChoice || "–"}<small style="opacity:.6"> ${s.memberTally.total}人</small></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" style="color:#a9bce8;">後台尚未建立組別</td></tr>`;

  paintMatrix(board);
  paintReps(gl);
}

function bars(q, t, key, denom) {
  if (!q) return `<p class="hint" style="text-align:left;">—</p>`;
  const total = t.total || 0;
  return LETTERS.filter(L => q[L.toLowerCase()]).map(L => {
    const n = t[L], pct = total ? Math.round(n / total * 100) : 0;
    return `<div class="bar-row">
      <span class="bar-key">${L}</span>
      <span class="bar-track"><span class="bar-fill${L === key ? " is-correct" : ""}" style="width:${pct}%"></span></span>
      <span class="bar-num">${n}（${pct}%）</span>
    </div>`;
  }).join("");
}

function paintMatrix(board) {
  const mx = categoryMatrix(board);

  if (!mx.cats.length || !mx.rows.length) {
    $("#mx-table").innerHTML = `<tbody><tr><td class="hint" style="text-align:left;">還沒有已公布的正式題目，公布第一題之後就會出現。</td></tr></tbody>`;
    $("#mx-champs").innerHTML = "";
    $("#mx-best").innerHTML   = "";
    return;
  }

  const wins    = columnWinners(mx);
  const bestOf  = groupBestCategories(mx);
  const bestIdx = new Map(bestOf.map(b => [b.gid, b.cat ? mx.cats.findIndex(c => c.id === b.cat.id) : -1]));

  $("#mx-table").innerHTML = `
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
    </tbody>`;

  $("#mx-champs").innerHTML = categoryChampions(mx).map(({ cat, best }) => `
    <div class="row" style="align-items:center; gap:8px;">
      <span class="cat-pill" style="--cat:${cat.color}">${escapeHtml(cat.name)}</span>
      <span style="font-weight:800;">${best ? escapeHtml(best.name) : "—"}</span>
      <span style="color:var(--gold-lt); font-weight:800;">${best ? best.points + "/" + best.max : ""}</span>
    </div>`).join("");

  $("#mx-best").innerHTML = bestOf.map(b => `
    <div class="row" style="align-items:center; gap:8px;">
      <span style="font-weight:800; min-width:72px;">${escapeHtml(b.name)}</span>
      ${b.cat
        ? `<span class="cat-pill" style="--cat:${b.cat.color}">${escapeHtml(b.cat.name)}</span>
           <span style="color:var(--gold-lt); font-weight:800;">${b.cell.points}/${b.cell.max}</span>`
        : `<span class="hint">尚無得分</span>`}
    </div>`).join("");
}

function paintReps(gl) {
  $("#rep-list").innerHTML = gl.length
    ? gl.map(g => {
        const r = reps[g.id];
        return `<div class="repline" data-gid="${escapeHtml(g.id)}">
          <span class="nm">${escapeHtml(g.name)}</span>
          <span class="${r ? "pill live" : "pill lock"}">${r ? "已就位" : "尚無代表"}</span>
          <button class="btn ghost mini rep-free" ${r ? "" : "disabled"}>釋放</button>
        </div>`;
      }).join("")
    : `<p class="hint" style="text-align:left;">後台尚未建立組別。</p>`;
}

$("#rep-list").addEventListener("click", async e => {
  if (!e.target.classList.contains("rep-free")) return;
  const gid = e.target.closest("[data-gid]").dataset.gid;
  if (!confirm(`釋放「${groups[gid]?.name}」的代表位置？該組要有人重新選「上台代表」。`)) return;
  await remove(ref(db, `${PATH.reps}/${gid}`));
  toast("已釋放");
});

// ------------------------------------------------------------
//  QR Code
// ------------------------------------------------------------
const playerUrl = new URL("index.html", location.href).href;

$("#btn-qr").addEventListener("click", async () => {
  $("#qr-url").textContent = playerUrl;
  show($("#qr-box"), true);
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
    $("#qr-img").src = qr.createDataURL(8, 4);
  } catch {
    $("#qr-url").textContent = "（QR 產生器載入失敗，請直接把網址給學生）\n" + playerUrl;
  }
});
$("#btn-qr-close").addEventListener("click", () => show($("#qr-box"), false));
