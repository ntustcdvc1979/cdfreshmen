// ============================================================
//  題目／組別 後台
// ============================================================

import {
  db, auth, ref, onValue, set, update, remove,
  signInWithGoogle, consumeRedirectResult, authErrorText, signOut, onAuthStateChanged,
  PATH, LETTERS, CATEGORIES, UNCATEGORIZED, categoryOf, parseBulkQuestions,
  $, show, toast, toSortedList, escapeHtml, isHost, notHostHtml
} from "./common.js";

// 類別下拉選單與批次匯入的說明文字
$("#ed-cat").innerHTML =
  `<option value="">${UNCATEGORIZED.name}</option>` +
  CATEGORIES.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
$("#bulk-cats").innerHTML =
  CATEGORIES.map(c => `<code style="color:${c.color}">${escapeHtml(c.name)}</code>`).join(" ");

let groups = {}, questions = {}, keys = {};
let editing = null;            // 正在編輯的題目 id；"new" 代表新增
let booted = false;

// ---------- 登入 ----------
onAuthStateChanged(auth, async user => {
  const ok = await isHost(user);
  show($("#scr-login"), !ok);
  show($("#scr-main"),   ok);

  if (user && !ok) {
    $("#login-msg").innerHTML = notHostHtml(user);
    await signOut(auth);
    return;
  }
  if (ok && !booted) { booted = true; attach(); }
});

consumeRedirectResult().then(e => { if (e) $("#login-msg").textContent = authErrorText(e); });

$("#btn-login").addEventListener("click", async () => {
  $("#btn-login").disabled = true;
  $("#login-msg").textContent = "登入中…";
  try {
    await signInWithGoogle();
  } catch (e) {
    $("#login-msg").textContent = authErrorText(e);
  } finally {
    $("#btn-login").disabled = false;
  }
});
$("#btn-logout").addEventListener("click", () => signOut(auth).then(() => location.reload()));

function attach() {
  onValue(ref(db, PATH.groups),    s => { groups    = s.val() || {}; paintGroups(); });
  onValue(ref(db, PATH.questions), s => { questions = s.val() || {}; paintQuestions(); });
  onValue(ref(db, PATH.answerKey), s => { keys      = s.val() || {}; paintQuestions(); });
}

const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ============================================================
//  組別
// ============================================================
function paintGroups() {
  const list = toSortedList(groups);
  $("#g-count").textContent = list.length + " 組";
  $("#g-list").innerHTML = list.map(g => `
    <div class="row" data-gid="${escapeHtml(g.id)}" style="align-items:center;">
      <input class="g-name" value="${escapeHtml(g.name)}" style="flex:1 1 160px;">
      <button class="btn ghost mini g-up">↑</button>
      <button class="btn ghost mini g-down">↓</button>
      <button class="btn danger mini g-del">刪除</button>
    </div>`).join("") || `<p class="hint" style="text-align:left;">尚未建立任何組別。學生會看不到可選的組別。</p>`;
}

$("#g-list").addEventListener("click", async e => {
  const row = e.target.closest("[data-gid]");
  if (!row) return;
  const gid  = row.dataset.gid;
  const list = toSortedList(groups);
  const i    = list.findIndex(g => g.id === gid);

  if (e.target.classList.contains("g-del")) {
    if (!confirm(`刪除「${groups[gid].name}」？已選這組的學生會被要求重選。`)) return;
    await remove(ref(db, `${PATH.groups}/${gid}`));
  } else if (e.target.classList.contains("g-up") && i > 0) {
    await swapOrder(PATH.groups, list[i], list[i - 1]);
  } else if (e.target.classList.contains("g-down") && i < list.length - 1) {
    await swapOrder(PATH.groups, list[i], list[i + 1]);
  }
});

$("#g-list").addEventListener("change", async e => {
  if (!e.target.classList.contains("g-name")) return;
  const gid = e.target.closest("[data-gid]").dataset.gid;
  const name = e.target.value.trim();
  if (!name) { paintGroups(); return; }
  await update(ref(db, `${PATH.groups}/${gid}`), { name });
  toast("已更新組名");
});

$("#g-add").addEventListener("click", async () => {
  const name = $("#g-new").value.trim();
  if (!name) return;
  await set(ref(db, `${PATH.groups}/${newId("g")}`), { name, order: toSortedList(groups).length });
  $("#g-new").value = "";
  toast("已新增");
});

$("#g-bulk").addEventListener("click", async () => {
  const n = parseInt(prompt("要建立幾組？（會建立「第 1 組」到「第 N 組」，不會刪除現有組別）", "8"), 10);
  if (!Number.isFinite(n) || n < 1 || n > 60) return;
  const base = toSortedList(groups).length;
  const payload = {};
  for (let i = 1; i <= n; i++) payload[newId("g")] = { name: `第 ${i} 組`, order: base + i - 1 };
  await update(ref(db, PATH.groups), payload);
  toast(`已建立 ${n} 組`);
});

async function swapOrder(path, a, b) {
  await update(ref(db, path), { [`${a.id}/order`]: b.order ?? 0, [`${b.id}/order`]: a.order ?? 0 });
}

// ============================================================
//  題目
// ============================================================
function paintQuestions() {
  const list = toSortedList(questions);
  $("#q-count").textContent = list.length + " 題";
  $("#q-list").innerHTML = list.map((q, i) => {
    const cat = categoryOf(q.cat);
    return `
    <div class="qitem ${editing === q.id ? "editing" : ""}" data-qid="${escapeHtml(q.id)}">
      <div class="head">
        <span class="no">第 ${i + 1} 題</span>
        <span class="txt">${escapeHtml(q.text || "（無題幹）")}</span>
        <span class="ans">${keys[q.id] ? "正解 " + keys[q.id] : "⚠ 無正解"}</span>
      </div>
      <div style="margin-top:8px;"><span class="cat-pill" style="--cat:${cat.color}">${escapeHtml(cat.name)}</span></div>
      <div class="row" style="margin-top:10px;">
        <button class="btn ghost mini q-edit">編輯</button>
        <button class="btn ghost mini q-up">↑</button>
        <button class="btn ghost mini q-down">↓</button>
      </div>
    </div>`;
  }).join("") || `<p class="hint" style="text-align:left;">尚未建立任何題目。</p>`;
}

$("#q-list").addEventListener("click", async e => {
  const item = e.target.closest("[data-qid]");
  if (!item) return;
  const qid  = item.dataset.qid;
  const list = toSortedList(questions);
  const i    = list.findIndex(q => q.id === qid);

  if (e.target.classList.contains("q-edit"))       openEditor(qid);
  else if (e.target.classList.contains("q-up")   && i > 0)               await swapOrder(PATH.questions, list[i], list[i - 1]);
  else if (e.target.classList.contains("q-down") && i < list.length - 1) await swapOrder(PATH.questions, list[i], list[i + 1]);
});

$("#q-add").addEventListener("click", () => openEditor("new"));

function openEditor(qid) {
  editing = qid;
  const q = qid === "new" ? {} : (questions[qid] || {});
  $("#ed-title").textContent = qid === "new" ? "新增題目" : "編輯第 " + (toSortedList(questions).findIndex(x => x.id === qid) + 1) + " 題";
  $("#ed-cat").value  = q.cat || "";
  $("#ed-text").value = q.text || "";
  for (const L of LETTERS) $("#ed-" + L.toLowerCase()).value = q[L.toLowerCase()] || "";
  $("#ed-key").value = (qid === "new" ? "A" : keys[qid]) || "A";
  show($("#ed-del"), qid !== "new");
  show($("#editor"), true);
  paintQuestions();
  $("#editor").scrollIntoView({ behavior: "smooth", block: "center" });
}

function closeEditor() {
  editing = null;
  show($("#editor"), false);
  paintQuestions();
}

$("#ed-cancel").addEventListener("click", closeEditor);

$("#ed-save").addEventListener("click", async () => {
  const text = $("#ed-text").value.trim();
  if (!text) { toast("請輸入題幹"); return; }

  const data = { text };
  if ($("#ed-cat").value) data.cat = $("#ed-cat").value;
  for (const L of LETTERS) {
    const v = $("#ed-" + L.toLowerCase()).value.trim();
    if (v) data[L.toLowerCase()] = v;
  }
  if (!data.a || !data.b) { toast("至少要填 A、B 兩個選項"); return; }

  const key = $("#ed-key").value;
  if (!data[key.toLowerCase()]) { toast(`正解設為 ${key}，但選項 ${key} 是空的`); return; }

  const qid = editing === "new" ? newId("q") : editing;
  data.order = editing === "new" ? toSortedList(questions).length : (questions[qid]?.order ?? 0);

  await set(ref(db, `${PATH.questions}/${qid}`), data);
  await set(ref(db, `${PATH.answerKey}/${qid}`), key);
  toast("已儲存");
  closeEditor();
});

$("#ed-del").addEventListener("click", async () => {
  if (editing === "new" || !editing) return;
  if (!confirm("刪除這一題？相關作答紀錄也會一起刪除。")) return;
  const qid = editing;
  await Promise.all([
    remove(ref(db, `${PATH.questions}/${qid}`)),
    remove(ref(db, `${PATH.answerKey}/${qid}`)),
    remove(ref(db, `${PATH.responses}/${qid}`)),
    remove(ref(db, `${PATH.stats}/${qid}`)),
    remove(ref(db, `${PATH.state}/revealed/${qid}`))
  ]);
  toast("已刪除");
  closeEditor();
});

// ============================================================
//  批次貼上
// ============================================================
async function writeBulk(items, replace) {
  if (replace) {
    await Promise.all([
      remove(ref(db, PATH.questions)),
      remove(ref(db, PATH.answerKey)),
      remove(ref(db, PATH.responses)),
      remove(ref(db, PATH.stats)),
      remove(ref(db, `${PATH.state}/revealed`))
    ]);
  }
  const base = replace ? 0 : toSortedList(questions).length;
  const qs = {}, ks = {};
  items.forEach(({ q, key }, i) => {
    const id = newId("q");
    qs[id] = { ...q, order: base + i };
    ks[id] = key;
  });
  await update(ref(db, PATH.questions), qs);
  await update(ref(db, PATH.answerKey), ks);
}

$("#bulk-append").addEventListener("click", () => runBulk(false));
$("#bulk-replace").addEventListener("click", () => {
  if (!confirm("會刪除現有全部題目與作答紀錄，確定嗎？")) return;
  runBulk(true);
});

async function runBulk(replace) {
  try {
    const items = parseBulkQuestions($("#bulk-in").value);
    await writeBulk(items, replace);
    $("#bulk-in").value = "";
    toast(`已匯入 ${items.length} 題`);
  } catch (e) {
    alert("匯入失敗：\n" + e.message);
  }
}
