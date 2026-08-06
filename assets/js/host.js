// ============================================================
//  主持人控制台
// ============================================================

import {
  db, auth, ref, onValue, set, update, remove,
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  PATH, PHASE, LETTERS, $, show, toast, toSortedList, escapeHtml,
  tallyQuestion, buildLeaderboard
} from "./common.js";

let groups = {}, questions = {}, keys = {}, allResp = {}, state = {};
let curQid = null;          // 控制台上正在看的題目
let booted = false;

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
onAuthStateChanged(auth, user => {
  show($("#scr-login"),   !user);
  show($("#scr-console"),  !!user);
  if (user) {
    $("#tag-who").textContent = user.email;
    if (!booted) { booted = true; attach(); }
  }
});

$("#btn-login").addEventListener("click", doLogin);
$("#in-pass").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

async function doLogin() {
  const email = $("#in-email").value.trim();
  const pass  = $("#in-pass").value;
  if (!email || !pass) return;
  $("#login-msg").textContent = "登入中…";
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    $("#login-msg").textContent = "登入失敗：" + (e.code || e.message);
  }
}

$("#btn-logout").addEventListener("click", () => signOut(auth).then(() => location.reload()));

// ------------------------------------------------------------
//  資料監聽（登入後才掛，否則會被安全性規則擋下）
// ------------------------------------------------------------
function attach() {
  onValue(ref(db, PATH.groups),    s => { groups    = s.val() || {}; paint(); });
  onValue(ref(db, PATH.answerKey), s => { keys      = s.val() || {}; paint(); });
  onValue(ref(db, PATH.responses), s => { allResp   = s.val() || {}; paint(); });
  onValue(ref(db, PATH.state),     s => { state     = s.val() || {}; syncFromState(); paint(); });
  onValue(ref(db, PATH.questions), s => {
    questions = s.val() || {};
    const list = toSortedList(questions);
    $("#sel-q").innerHTML = list.length
      ? list.map((q, i) => `<option value="${escapeHtml(q.id)}">第 ${i + 1} 題　${escapeHtml((q.text || "").slice(0, 26))}</option>`).join("")
      : '<option value="">（後台尚未建立題目）</option>';
    if (!curQid && list.length) curQid = state.qid || list[0].id;
    if (curQid) $("#sel-q").value = curQid;
    paint();
  });
}

function syncFromState() {
  if (state.qid && state.qid !== curQid) {
    curQid = state.qid;
    if ($("#sel-q").querySelector(`option[value="${CSS.escape(curQid)}"]`)) $("#sel-q").value = curQid;
  }
}

$("#sel-q").addEventListener("change", async () => {
  curQid = $("#sel-q").value;
  await update(ref(db, PATH.state), { qid: curQid, phase: PHASE.IDLE });
  paint();
});

// ------------------------------------------------------------
//  控制動作
// ------------------------------------------------------------
const qList = () => toSortedList(questions);
const qIndex = qid => qList().findIndex(q => q.id === qid);

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
  await update(ref(db, PATH.state), { qid, phase: PHASE.OPEN });
  toast("第 " + (qIndex(qid) + 1) + " 題　開放作答");
}

/** 公布答案：先算好統計寫進 /stats，再把這題標記為已公布（學生才讀得到正解） */
async function doReveal() {
  const qid = curQid;
  if (!qid) return;
  const key = keys[qid];
  if (!key) { toast("這題還沒設定正解，請先到後台補上"); return; }

  const tally = tallyQuestion(allResp[qid], key);
  await set(ref(db, `${PATH.stats}/${qid}`), tally);
  await update(ref(db, PATH.state), {
    phase: PHASE.REVEAL,
    qid,
    [`revealed/${qid}`]: true
  });
  toast("已公布答案：" + key);
}

/** 結束：算出排行榜寫進 /leaderboard，學生端就能看到 */
async function doFinal() {
  if (!confirm("要結束遊戲並公布最終排行榜嗎？")) return;
  const rows = buildLeaderboard(groups, questions, keys, allResp, state.revealed);
  await set(ref(db, PATH.leaderboard), { updatedAt: Date.now(), rows });
  await update(ref(db, PATH.state), { phase: PHASE.FINAL });
  toast("排行榜已公布");
}

$("#btn-reset").addEventListener("click", async () => {
  if (!confirm("確定清除「所有」作答紀錄、統計與排行榜？此動作無法復原。")) return;
  if (!confirm("再確認一次：所有人的答案都會消失。")) return;
  await Promise.all([
    remove(ref(db, PATH.responses)),
    remove(ref(db, PATH.stats)),
    remove(ref(db, PATH.leaderboard)),
    set(ref(db, PATH.state), { phase: PHASE.IDLE, qid: curQid || null, revealed: null })
  ]);
  toast("已清除");
});

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
  const resp = qid ? (allResp[qid] || {}) : {};
  const tally = tallyQuestion(resp, key);

  $("#live-q").textContent   = q ? `第 ${qIndex(qid) + 1} 題　${q.text || ""}` : "尚未選擇題目";
  $("#live-key").textContent = key || "（未設定）";
  $("#live-count").textContent = tally.total + " 人已作答";

  $("#live-bars").innerHTML = LETTERS
    .filter(L => q && q[L.toLowerCase()])
    .map(L => {
      const n = tally[L], pct = tally.total ? Math.round(n / tally.total * 100) : 0;
      return `<div class="bar-row">
        <span class="bar-key">${L}</span>
        <span class="bar-track"><span class="bar-fill${L === key ? " is-correct" : ""}" style="width:${pct}%"></span></span>
        <span class="bar-num">${n} 人 ${pct}%</span>
      </div>`;
    }).join("") || `<p class="hint" style="text-align:left;">—</p>`;

  // 各組排名 + 本題已作答人數
  const perGroupNow = {};
  for (const r of Object.values(resp)) perGroupNow[r?.g] = (perGroupNow[r?.g] || 0) + 1;

  const rows = buildLeaderboard(groups, questions, keys, allResp, state.revealed);
  $("#rank-rows").innerHTML = rows.length
    ? rows.map((r, i) => `<tr class="${i === 0 && r.answered ? "top1" : ""}">
        <td>${i + 1}</td>
        <td>${escapeHtml(r.name)}</td>
        <td class="n">${r.rate}%</td>
        <td class="n">${r.correct}/${r.answered}</td>
        <td class="n">${perGroupNow[r.gid] || 0}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" style="color:#a9bce8;">後台尚未建立組別</td></tr>`;
}

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
