// ============================================================
//  共用工具：Firebase 初始化、資料路徑、計分邏輯
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase, ref, onValue, get, set, update, remove, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

export const app  = initializeApp(firebaseConfig);
export const db   = getDatabase(app);
export const auth = getAuth(app);

export {
  ref, onValue, get, set, update, remove, serverTimestamp,
  signOut, onAuthStateChanged
};

/**
 * 用 Google 帳號登入。
 * 優先用彈出視窗；被瀏覽器擋掉或環境不支援時，退回整頁轉址。
 */
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    // 使用者自己關掉視窗就不要再轉址，其餘擋不住的情況才退回整頁登入
    const fallback = [
      "auth/popup-blocked",
      "auth/cancelled-popup-request",
      "auth/operation-not-supported-in-this-environment"
    ];
    if (fallback.includes(e?.code)) { await signInWithRedirect(auth, provider); return; }
    throw e;
  }
}

/** 頁面載入時處理轉址回來的結果；沒有轉址就什麼也不做 */
export async function consumeRedirectResult() {
  try { await getRedirectResult(auth); } catch (e) { return e; }
  return null;
}

/**
 * 登入成功、但不在主持人名單上時要顯示的說明。
 * 把 UID 直接秀出來，方便複製貼到 Firebase 主控台。
 */
export function notHostHtml(user) {
  return `「${escapeHtml(user.email || user.uid)}」不在主持人名單裡。<br>
    請到 Firebase 主控台 → Realtime Database，在 <code>admins</code> 底下新增這組 UID（值填 <code>true</code>）：<br>
    <code style="user-select:all; display:inline-block; margin-top:6px; font-size:14px;">${escapeHtml(user.uid)}</code>`;
}

/** 把 Firebase 的錯誤碼翻成看得懂的中文 */
export function authErrorText(e) {
  const code = e?.code || "";
  const map = {
    "auth/popup-closed-by-user":   "登入視窗被關閉了，請再試一次。",
    "auth/popup-blocked":          "瀏覽器擋掉了登入視窗，請允許彈出視窗後再試。",
    "auth/unauthorized-domain":    "這個網域還沒被授權。請到 Firebase 主控台 → Authentication → 設定 → 授權網域，加入 " + location.hostname + "。",
    "auth/operation-not-allowed":  "Google 登入方式還沒啟用。請到 Firebase 主控台 → Authentication → 登入方式 啟用 Google。",
    "auth/admin-restricted-operation": "這個 Google 帳號還沒有帳號，而專案已關閉自行註冊。請先在 Firebase 主控台把它加為使用者。",
    "auth/network-request-failed":  "網路連線失敗，請確認網路後再試。"
  };
  return map[code] || ("登入失敗：" + (code || e?.message || "未知錯誤"));
}

// ---------- 資料庫路徑 ----------
//  /config/groups/{gid}      = { name, order }
//  /questions/{qid}          = { order, text, a, b, c, d }     ← 全世界可讀（不含正解）
//  /answerKey/{qid}          = "A"                             ← 只有公布後才讀得到
//  /state                    = { phase, qid, revealed:{qid:true} }
//  /responses/{qid}/{client} = { g:組別id, c:"A", t:時間 }
//  /stats/{qid}              = { A,B,C,D, total, key }         ← 公布後由主持人寫入
//  /leaderboard              = { updatedAt, rows:[{gid,name,answered,correct,rate}] }
export const PATH = {
  admins:     "admins",
  groups:     "config/groups",
  questions:  "questions",
  answerKey:  "answerKey",
  state:      "state",
  responses:  "responses",
  stats:      "stats",
  leaderboard:"leaderboard"
};

export const PHASE = {
  IDLE:   "idle",    // 待機（尚未開始 / 題目間空檔）
  OPEN:   "open",    // 題目已出，開放作答
  LOCKED: "locked",  // 停止作答，尚未公布
  REVEAL: "reveal",  // 公布答案
  FINAL:  "final"    // 全部結束，看排行榜
};

export const LETTERS = ["A", "B", "C", "D"];

/**
 * 題目類別。順序與顏色對應活動主視覺上那六張卡片。
 * 要增減或改名直接改這裡；已存在的題目是用 id 存的，改 name 不會影響舊資料。
 */
export const CATEGORIES = [
  { id: "social",   name: "人際網絡高手", color: "#e6266f" },
  { id: "goodwill", name: "親善大使",     color: "#f0ad00" },
  { id: "food",     name: "美食小當家",   color: "#14a05a" },
  { id: "time",     name: "時間管理大師", color: "#dd7b0e" },
  { id: "emotion",  name: "情緒管理大師", color: "#8b5cf6" },
  { id: "team",     name: "團隊領航員",   color: "#2f7bf6" }
];

export const UNCATEGORIZED = { id: "uncat", name: "未分類", color: "#7b8bb5" };

/** 由 id 取回類別（找不到就回傳「未分類」） */
export function categoryOf(id) {
  return CATEGORIES.find(c => c.id === id) || UNCATEGORIZED;
}

// ---------- 小工具 ----------

/** 這台裝置的固定識別碼（同一組多人 → 每支手機一筆答案） */
export function clientId() {
  let id = localStorage.getItem("cdf_client");
  if (!id) {
    id = "c" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    localStorage.setItem("cdf_client", id);
  }
  return id;
}

/**
 * 這個帳號是不是主持人。
 * 光是「登入成功」不代表有權限 —— 必須在資料庫的 /admins/{uid} 被列名。
 * 因為 Firebase 的 API 金鑰是公開的，只要開放了 Email/Password 登入方式，
 * 任何人都能自己註冊一個帳號；真正的門檻在這裡。
 */
export async function isHost(user) {
  if (!user) return false;
  try {
    const snap = await get(ref(db, `${PATH.admins}/${user.uid}`));
    return snap.val() === true;
  } catch {
    return false;
  }
}

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function show(el, visible = true) {
  if (el) el.classList.toggle("hidden", !visible);
}

let toastTimer;
export function toast(msg, ms = 2200) {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

/**
 * 解析批次貼上的題目。一行一題，用 | 分隔：
 *   題幹 | A選項 | B選項 | C選項 | D選項 | 正解字母 | 類別（可省略）
 * 回傳 [{ q:{text,a,b,c,d,cat}, key:"A" }…]，格式有問題就丟出帶行內容的錯誤。
 */
export function parseBulkQuestions(raw) {
  const out = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const where = `：${t.slice(0, 30)}…`;

    const parts = t.split("|").map(s => s.trim());
    if (parts.length < 4) throw new Error(`這行欄位不夠${where}`);

    // 最後一欄可能是正解，也可能是類別（類別在正解後面）
    let cat = "";
    if (!LETTERS.includes((parts[parts.length - 1] || "").toUpperCase())) {
      const named = parts.pop();
      const found = CATEGORIES.find(c => c.name === named || c.id === named);
      if (!found) throw new Error(`看不懂最後一欄「${named}」，要嘛是正解 A/B/C/D，要嘛是類別名稱${where}`);
      cat = found.id;
      if (!LETTERS.includes((parts[parts.length - 1] || "").toUpperCase())) {
        throw new Error(`類別前面那一欄要是正解 A/B/C/D${where}`);
      }
    }

    const key = parts.pop().toUpperCase();      // 拿掉正解，剩下題幹與選項
    const [text, a, b, c, d] = parts;
    if (!text || !a || !b) throw new Error(`題幹與 A、B 選項不能空白${where}`);

    const q = { text, a, b };
    if (c) q.c = c;
    if (d) q.d = d;
    if (cat) q.cat = cat;
    if (!q[key.toLowerCase()]) throw new Error(`正解是 ${key}，但選項 ${key} 沒有填${where}`);

    out.push({ q, key });
  }
  if (!out.length) throw new Error("沒有讀到任何題目");
  return out;
}

/** 物件 → 陣列，附上 key，並依 order 排序 */
export function toSortedList(obj) {
  if (!obj) return [];
  return Object.entries(obj)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

// ---------- 計分 ----------

/**
 * 統計單一題目的 ABCD 分布。
 * @param {object} responses  /responses/{qid} 的原始資料
 * @param {string} key        正解字母
 */
export function tallyQuestion(responses, key) {
  const out = { A: 0, B: 0, C: 0, D: 0, total: 0, key: key ?? null };
  for (const r of Object.values(responses || {})) {
    if (!LETTERS.includes(r?.c)) continue;
    out[r.c]++;
    out.total++;
  }
  return out;
}

/**
 * 依「組別答對率」算排行榜。
 * 答對率 = 該組所有已公布題目的答對人次 ÷ 作答人次。
 * 同分時比答對人次多的排前面。
 */
export function buildLeaderboard(groups, questions, answerKeys, allResponses, revealed) {
  const acc = {};
  for (const g of toSortedList(groups)) {
    acc[g.id] = { gid: g.id, name: g.name, answered: 0, correct: 0, rate: 0 };
  }

  for (const q of toSortedList(questions)) {
    if (!revealed?.[q.id]) continue;              // 只算已公布的題目
    const key = answerKeys?.[q.id];
    if (!key) continue;
    for (const r of Object.values(allResponses?.[q.id] || {})) {
      const row = acc[r?.g];
      if (!row || !LETTERS.includes(r?.c)) continue;
      row.answered++;
      if (r.c === key) row.correct++;
    }
  }

  return Object.values(acc)
    .map(r => ({ ...r, rate: r.answered ? Math.round(r.correct / r.answered * 1000) / 10 : 0 }))
    .sort((a, b) => b.rate - a.rate || b.correct - a.correct || a.name.localeCompare(b.name, "zh-Hant"));
}

/**
 * 組別 × 類別 的答對率矩陣。
 * 只計算已公布的題目，rate 為 null 代表該組在那個類別完全沒作答。
 * 回傳 { cats:[類別…], rows:[{gid,name,cells:[{cat,answered,correct,rate}…]}…] }
 * cells 的順序與 cats 一一對應。
 */
export function buildCategoryMatrix(groups, questions, answerKeys, allResponses, revealed) {
  const gl = toSortedList(groups);
  const acc = {};                       // acc[gid][catId] = { answered, correct }
  const used = new Set();
  for (const g of gl) acc[g.id] = {};

  for (const q of toSortedList(questions)) {
    if (!revealed?.[q.id]) continue;
    const key = answerKeys?.[q.id];
    if (!key) continue;
    const cat = categoryOf(q.cat).id;
    used.add(cat);
    for (const r of Object.values(allResponses?.[q.id] || {})) {
      const bucket = acc[r?.g];
      if (!bucket || !LETTERS.includes(r?.c)) continue;
      bucket[cat] ??= { answered: 0, correct: 0 };
      bucket[cat].answered++;
      if (r.c === key) bucket[cat].correct++;
    }
  }

  const cats = CATEGORIES.filter(c => used.has(c.id));
  if (used.has(UNCATEGORIZED.id)) cats.push(UNCATEGORIZED);

  const rows = gl.map(g => ({
    gid: g.id,
    name: g.name,
    cells: cats.map(c => {
      const v = acc[g.id][c.id];
      return {
        cat: c.id,
        answered: v?.answered || 0,
        correct: v?.correct || 0,
        rate: v?.answered ? Math.round(v.correct / v.answered * 1000) / 10 : null
      };
    })
  }));

  return { cats, rows };
}

/** 比較兩個格子誰比較強：先比答對率，再比答對人次 */
function better(a, b) {
  if (!a || a.rate === null) return false;
  if (!b || b.rate === null) return true;
  return a.rate > b.rate || (a.rate === b.rate && a.correct > b.correct);
}

/** 每個類別的冠軍組別 → [{ cat, best:{gid,name,rate,correct,answered} | null }] */
export function categoryChampions(matrix) {
  return matrix.cats.map((cat, i) => {
    let best = null;
    for (const row of matrix.rows) {
      const cell = row.cells[i];
      if (better(cell, best)) best = { gid: row.gid, name: row.name, ...cell };
    }
    return { cat, best };
  });
}

/** 每一組最擅長的類別 → [{ gid, name, cat, cell } | cat 為 null 代表沒作答] */
export function groupBestCategories(matrix) {
  return matrix.rows.map(row => {
    let best = null, at = -1;
    row.cells.forEach((cell, i) => { if (better(cell, best)) { best = cell; at = i; } });
    return { gid: row.gid, name: row.name, cat: at >= 0 ? matrix.cats[at] : null, cell: best };
  });
}

/** 矩陣中每一欄（類別）最強的那一列索引，用來在表格上標記 */
export function columnWinners(matrix) {
  return matrix.cats.map((_, i) => {
    let best = null, at = -1;
    matrix.rows.forEach((row, r) => { if (better(row.cells[i], best)) { best = row.cells[i]; at = r; } });
    return at;
  });
}
