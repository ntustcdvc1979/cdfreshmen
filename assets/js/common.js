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
