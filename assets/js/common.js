// ============================================================
//  共用工具：Firebase 初始化、資料路徑、計分邏輯
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase, ref, onValue, get, set, update, remove, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

export const app  = initializeApp(firebaseConfig);
export const db   = getDatabase(app);
export const auth = getAuth(app);

export {
  ref, onValue, get, set, update, remove, serverTimestamp,
  signInWithEmailAndPassword, signOut, onAuthStateChanged
};

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
