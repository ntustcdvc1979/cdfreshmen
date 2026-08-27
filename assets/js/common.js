// ============================================================
//  共用工具：Firebase 初始化、資料路徑、計分邏輯
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase, ref, onValue, get, set, update, remove, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signInAnonymously, signOut, onAuthStateChanged
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
 * 學員端用匿名登入。
 * 需要它是因為：代表要讀「自己這一組」的學員作答比例，而安全性規則必須認得出
 * 「你就是這組的代表」才能放行；沒有身分就只能把所有人的作答全部公開。
 * 同時也用來確保一組只有一位代表、以及沒有人能改別人的答案。
 *
 * ⚠ 這代表 Firebase 的「啟用建立帳戶」不能關掉（匿名登入也算建立帳戶）。
 *   權限邊界是 /admins 白名單，不是靠禁止註冊 —— 匿名使用者拿不到任何主持人權限。
 */
export async function ensureAnonAuth() {
  if (auth.currentUser) return auth.currentUser;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

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
//  /admins/{uid}                  = true                            ← 主持人白名單，只能從主控台改
//  /config/groups/{gid}           = { name, order }
//  /config/intro                  = { rulesImg }                     ← 規則頁的圖（選填）
//  /questions/{qid}               = { order, text, a,b,c,d, cat, list, pts,
//                                     blocks:[…], exImgFull }         ← 公開可讀，不含正解
//     blocks = 說明頁的排版區塊，一格一個：
//       { t:"text"|"img"|"head", v:內容, w:"full"|"half", size:1~5, align:"left"|"center" }
//     半行的區塊會自動並排成兩欄。舊的 exText / exImg 仍然讀得到（會自動轉成區塊）。
//  /answerKey/{qid}               = "A"                              ← 只有公布後才讀得到
//  /state                         = { phase, list, qid, openedAt, limitSec,
//                                     gridCols, showRepLetters, revealed:{qid:true} }
//  /reps/{gid}                    = { uid, at }                      ← 該組代表（一組一位）
//  /repAnswers/{qid}/{gid}        = { c, uid, t }                     ← 代表按下確認後的答案
//  /responses/{qid}/{gid}/{uid}   = { c, t }                          ← 台下學員的作答
//  /stats/{qid}                   = { A,B,C,D,total,key, rep:{…} }    ← 公布時由主持人寫入
//  /doubles/{qid}                 = gid                              ← 轉盤抽中、該題分數 ×2 的組
//  /leaderboard                   = { updatedAt, rows:[…] }
export const PATH = {
  admins:     "admins",
  groups:     "config/groups",
  intro:      "config/intro",
  questions:  "questions",
  answerKey:  "answerKey",
  state:      "state",
  reps:       "reps",
  repAnswers: "repAnswers",
  responses:  "responses",
  stats:      "stats",
  doubles:    "doubles",
  leaderboard:"leaderboard"
};

export const PHASE = {
  IDLE:   "idle",    // 待機（尚未開始 / 題目間空檔）
  OPEN:   "open",    // 題目已出，開放作答
  LOCKED: "locked",  // 停止作答，尚未公布
  REVEAL: "reveal",  // 公布答案與說明
  FINAL:  "final"    // 全部結束，看排行榜
};

/** 題庫：正式題與 DEMO 練習題。DEMO 不計入排行榜。 */
export const LISTS = {
  MAIN: "main",
  DEMO: "demo"
};
export const LIST_LABEL = { main: "正式題目", demo: "DEMO 練習題" };

/** 進場時選的身分 */
export const ROLE = {
  REP:    "rep",      // 上台答題的代表，一組一位
  MEMBER: "member"    // 台下學員
};

export const LETTERS = ["A", "B", "C", "D"];

export const DEFAULT_LIMIT_SEC = 30;

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

// ---------- 說明頁排版區塊 ----------

export const BLOCK_TYPES = [
  { t: "head",  name: "小標題" },
  { t: "text",  name: "文字" },
  { t: "img",   name: "圖片" },
  { t: "video", name: "影片" }
];

/** 會佔版面的媒體類型 —— 只有一個的時候讓它佔滿整個說明區 */
export const MEDIA_TYPES = ["img", "video"];

export const BLOCK_SIZES = [1, 2, 3, 4, 5];

/** 區塊寬度。auto = 只佔內容需要的寬，連續的 auto 會緊貼排成一列 */
export const BLOCK_WIDTHS = [
  { w: "full", name: "整行" },
  { w: "half", name: "半行（可並排）" },
  { w: "auto", name: "自動寬（緊貼並排）" }
];

export const BLOCK_ALIGNS = [
  { a: "left",   name: "靠左" },
  { a: "center", name: "置中" },
  { a: "right",  name: "靠右" }
];
export const DEFAULT_BLOCK_SIZE = 3;

/** 文字級距（vh）—— 投影頁還會再依實際高度縮放 */
export const TEXT_SIZE_VH = { 1: 1.8, 2: 2.2, 3: 2.8, 4: 3.4, 5: 5.4 };
/** 圖片高度上限（vh） */
export const IMG_SIZE_VH  = { 1: 9,   2: 14,  3: 19,  4: 25,  5: 32  };

/** 把一個區塊補齊預設值 */
export function normalizeBlock(b) {
  const t = ["text", "img", "head", "video"].includes(b?.t) ? b.t : "text";
  const size = BLOCK_SIZES.includes(Math.round(Number(b?.size)))
    ? Math.round(Number(b.size)) : DEFAULT_BLOCK_SIZE;
  return {
    t,
    v: typeof b?.v === "string" ? b.v : "",
    w: ["half", "auto"].includes(b?.w) ? b.w : "full",
    size,
    align: ["center", "right"].includes(b?.align) ? b.align : "left"
  };
}

/**
 * 影片網址 → 實際要放進畫面的來源。
 * YouTube／Vimeo 轉成內嵌網址（要用 iframe），其他一律當成直接播放的影片檔。
 * 注意：內嵌的影片需要現場有網路，沒網路的場地請改放 mp4 檔。
 */
export function videoEmbed(url) {
  const u = (url || "").trim();
  if (!u) return { kind: "file", src: "" };
  const yt = u.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|live\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/
  );
  if (yt) return { kind: "embed", src: `https://www.youtube.com/embed/${yt[1]}?rel=0` };
  const vi = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vi) return { kind: "embed", src: `https://player.vimeo.com/video/${vi[1]}` };
  return { kind: "file", src: u };
}

/**
 * 站內圖片全部轉成 .webp 了，但後台資料庫裡可能還存著舊的 .png / .jpg 路徑。
 * 這裡先把副檔名換成 .webp，載不到時再由 onerror 退回原本的路徑 ——
 * 這樣舊題目不用重填，之後新放的 png 也照樣顯示。外部網址不動。
 */
export function webpSrc(url) {
  const u = (url || "").trim();
  if (/^(https?:)?\/\//i.test(u) || /^data:/i.test(u)) return u;
  return u.replace(/\.(png|jpe?g)$/i, ".webp");
}

/** 說明只有一張圖或一段影片時 → 讓它佔滿整個說明區 */
export function isSoloMedia(blocks) {
  return blocks.length === 1 && MEDIA_TYPES.includes(blocks[0].t);
}

/**
 * 把區塊分成一列一列。連續的「自動寬」區塊會收進同一列、中間只留一點點縫，
 * 兩張圖片才會是靠在一起的 A B，而不是各自置中、中間開天窗的 _A_ _B_。
 * 整列的對齊方式取這一列第一個區塊的 align（靠左／置中／靠右）。
 */
export function groupBlocks(blocks) {
  const rows = [];
  for (const b of blocks) {
    const last = rows[rows.length - 1];
    if (b.w === "auto" && last && last.auto) { last.items.push(b); continue; }
    rows.push({ auto: b.w === "auto", align: b.align, items: [b] });
  }
  return rows;
}

/**
 * 取出一題的說明區塊。
 * Firebase 可能把陣列存成物件，所以兩種都要接得住。
 * 沒有 blocks 但有舊的 exText / exImg 時，自動轉成等效的區塊，
 * 這樣舊題目不用重編也能照常顯示。
 */
export function blocksOf(q) {
  const raw = q?.blocks;
  let list = Array.isArray(raw) ? raw
           : raw && typeof raw === "object"
             ? Object.keys(raw).sort((a, b) => Number(a) - Number(b)).map(k => raw[k])
             : null;

  if (list && list.length) {
    return list.map(normalizeBlock).filter(b => b.v.trim());
  }

  // 舊格式轉換
  const out = [];
  const txt = (q?.exText || "").trim();
  const img = (q?.exImg || "").trim();
  if (txt) out.push(normalizeBlock({ t: "text", v: txt, w: img ? "half" : "full", size: 3 }));
  if (img) out.push(normalizeBlock({ t: "img",  v: img, w: txt ? "half" : "full", size: 4 }));
  return out;
}

/** 由 id 取回類別（找不到就回傳「未分類」） */
export function categoryOf(id) {
  return CATEGORIES.find(c => c.id === id) || UNCATEGORIZED;
}

// ---------- 小工具 ----------

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

// ---------- 題庫 ----------

/** 題目屬於哪個題庫（沒寫就當正式題） */
export const listOf = q => (q?.list === LISTS.DEMO ? LISTS.DEMO : LISTS.MAIN);

/** 取出某個題庫的題目，依 order 排序 */
export function questionsOf(questions, list) {
  return toSortedList(questions).filter(q => listOf(q) === list);
}

// ---------- 計分 ----------
//
//  每題每組最多拿到「配分 × 2」。兩筆分數互相獨立，各算各的：
//    代表答對                        → +配分
//    台下學員答對率 >= 50%           → +配分
//  代表沒送出（或送錯）不影響學員那一分 —— 學員過半照樣加分。
//  被轉盤抽中的那一組，該題的配分再 ×2。
//  配分預設 1，可以逐題調整（後台的「配分」欄位）。
//  排行榜就比總分。DEMO 題庫不計分。

export const MEMBER_PASS_RATE = 0.5;
export const DEFAULT_POINTS = 1;

/** 這一題值幾分（沒設定就是 1）。只接受 1～99 的整數。 */
export function ptsOf(q) {
  const n = Math.round(Number(q?.pts));
  return Number.isFinite(n) && n >= 1 && n <= 99 ? n : DEFAULT_POINTS;
}

/** 統計一組數字：{A,B,C,D,total} */
export function tally(entries) {
  const out = { A: 0, B: 0, C: 0, D: 0, total: 0 };
  for (const r of entries) {
    if (!LETTERS.includes(r?.c)) continue;
    out[r.c]++;
    out.total++;
  }
  return out;
}

/** 台下學員的作答分布：/responses/{qid}/{gid} → {A,B,C,D,total} */
export function tallyMembers(byGroup) {
  return tally(Object.values(byGroup || {}));
}

/** 全場所有組別加總的學員分布，用於公布時的整場統計 */
export function tallyAllMembers(byQuestion) {
  const all = [];
  for (const g of Object.values(byQuestion || {})) all.push(...Object.values(g || {}));
  return tally(all);
}

/** 各組代表的答案分布：/repAnswers/{qid} → {A,B,C,D,total} */
export function tallyReps(repsForQuestion) {
  return tally(Object.values(repsForQuestion || {}));
}

/**
 * 一組在一題上拿幾分。
 * 代表那一分與學員那一分互不影響：代表沒作答時 repOk 為 false，
 * 但 memberOk 完全由學員的答對率決定，照樣可以加分。
 * @returns { repChoice, repOk, memberTally, memberRate, memberOk, points }
 */
export function scoreOne(key, repAnswer, memberByGroup, pts = DEFAULT_POINTS) {
  const repChoice = LETTERS.includes(repAnswer?.c) ? repAnswer.c : null;
  const repOk     = repChoice ? repChoice === key : false;

  const mt   = tallyMembers(memberByGroup);
  const ok   = key && LETTERS.includes(key) ? mt[key] : 0;
  const rate = mt.total ? ok / mt.total : null;
  const memberOk = rate !== null && rate >= MEMBER_PASS_RATE;

  return {
    repChoice,
    repOk,
    memberTally: mt,
    memberCorrect: ok,
    memberRate: rate === null ? null : Math.round(rate * 1000) / 10,
    memberOk,
    pts,
    points: (repOk ? pts : 0) + (memberOk ? pts : 0)
  };
}

/**
 * 全場計分。只算「已公布」而且屬於指定題庫的題目。
 * @returns { rows:[…按分數排好…], cats:[出現過的類別…], questionCount }
 *   每個 row：{ gid, name, points, max, repCorrect, repAnswered,
 *              memberBonus, memberCorrect, memberAnswered, byCat:{catId:{points,max}} }
 */
export const DOUBLE_MULTIPLIER = 2;

export function buildScoreboard(groups, questions, answerKeys, responses, repAnswers, revealed,
                                list = LISTS.MAIN, doubles = null) {
  const qs = questionsOf(questions, list)
    .filter(q => revealed?.[q.id] && answerKeys?.[q.id]);

  const usedCats = new Set();
  const rows = toSortedList(groups).map(g => ({
    gid: g.id, name: g.name,
    points: 0, max: 0,
    repCorrect: 0, repAnswered: 0,
    memberBonus: 0, memberCorrect: 0, memberAnswered: 0,
    byCat: {}
  }));

  for (const q of qs) {
    const key = answerKeys[q.id];
    const cat = categoryOf(q.cat).id;
    usedCats.add(cat);

    const basePts = ptsOf(q);
    const doubledGid = doubles?.[q.id] || null;

    for (const row of rows) {
      // 被轉盤抽中的那一組，這一題的配分加倍（滿分也跟著加倍，得分率才不會爆表）
      const pts = row.gid === doubledGid ? basePts * DOUBLE_MULTIPLIER : basePts;

      row.byCat[cat] ??= { points: 0, max: 0 };
      row.byCat[cat].max += pts * 2;
      row.max += pts * 2;

      const s = scoreOne(key, repAnswers?.[q.id]?.[row.gid], responses?.[q.id]?.[row.gid], pts);
      if (s.repChoice) row.repAnswered++;
      if (s.repOk)     row.repCorrect++;
      row.memberAnswered += s.memberTally.total;
      row.memberCorrect  += s.memberCorrect;
      if (s.memberOk)  row.memberBonus++;

      row.points          += s.points;
      row.byCat[cat].points += s.points;
    }
  }

  const cats = CATEGORIES.filter(c => usedCats.has(c.id));
  if (usedCats.has(UNCATEGORIZED.id)) cats.push(UNCATEGORIZED);

  rows.sort((a, b) =>
    b.points - a.points ||
    b.repCorrect - a.repCorrect ||
    b.memberCorrect - a.memberCorrect ||
    a.name.localeCompare(b.name, "zh-Hant"));

  return { rows, cats, questionCount: qs.length };
}

/**
 * 組別 × 類別 的得分矩陣，直接由 buildScoreboard 的結果導出。
 * cells 的順序與 cats 一一對應；rate 為 null 代表那個類別還沒有題目公布。
 */
export function categoryMatrix(board) {
  return {
    cats: board.cats,
    rows: board.rows.map(r => ({
      gid: r.gid,
      name: r.name,
      cells: board.cats.map(c => {
        const v = r.byCat[c.id];
        return {
          cat: c.id,
          points: v?.points || 0,
          max: v?.max || 0,
          rate: v?.max ? Math.round(v.points / v.max * 1000) / 10 : null
        };
      })
    }))
  };
}

/** 比較兩個格子誰比較強：先比得分率，再比絕對得分 */
function better(a, b) {
  if (!a || a.rate === null) return false;
  if (!b || b.rate === null) return true;
  return a.rate > b.rate || (a.rate === b.rate && a.points > b.points);
}

/** 每個類別最強的組 → [{ cat, best:{gid,name,points,max,rate} | null }] */
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

/** 每一組最擅長的類別 → [{ gid, name, cat, cell }]，cat 為 null 代表還沒有分數 */
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

// ---------- 投影幕格子排版 ----------

/**
 * 幾組要切幾欄。在「盡量不留空格」與「盡量貼近 16:9」之間取平衡。
 * 主持人可以在控制台指定欄數蓋掉這個結果。
 */
export function gridColumns(n) {
  if (n <= 1) return 1;
  let best = { cols: n, score: Infinity };
  for (let cols = 1; cols <= n; cols++) {
    const rows   = Math.ceil(n / cols);
    const waste  = cols * rows - n;
    const aspect = (cols / rows) / (16 / 9);
    const score  = waste * 2 + Math.abs(Math.log(aspect)) * 6;
    if (score < best.score) best = { cols, score };
  }
  return best.cols;
}

// ---------- 倒數計時 ----------

/**
 * 還剩幾秒。用伺服器時間算，避免各裝置時鐘不同步。
 * @param openedAt  state.openedAt（伺服器毫秒）
 * @param limitSec  秒數上限
 * @param offset    /.info/serverTimeOffset 的值
 */
export function secondsLeft(openedAt, limitSec = DEFAULT_LIMIT_SEC, offset = 0) {
  if (!openedAt) return null;
  const now  = Date.now() + (offset || 0);
  const left = limitSec - (now - openedAt) / 1000;
  return Math.max(0, Math.ceil(left));
}

// ============================================================
//  加倍轉盤
// ============================================================

/**
 * [0, n) 的均勻亂數。
 * Math.random() 在同一輪裡很容易讓人覺得「又是他」，這裡改用 crypto，
 * 並且把會造成偏差的尾段丟掉重抽 —— 直接取餘數的話小的索引機率會偏高。
 */
export function randomIndex(n) {
  if (n <= 1) return 0;
  const c = globalThis.crypto;
  if (!c?.getRandomValues) return Math.floor(Math.random() * n);

  const limit = Math.floor(0xFFFFFFFF / n) * n;
  const buf = new Uint32Array(1);
  let v;
  do { c.getRandomValues(buf); v = buf[0]; } while (v >= limit);
  return v % n;
}

/**
 * 轉盤上還留著的組：抽過的就不再出現。
 * 已經抽過 = 出現在 /doubles 裡（那是每一題實際加倍到哪一組的紀錄）。
 * 全部都抽過了就重新開一輪，否則轉盤會變成空的。
 *
 * 主持人端與投影端都用這一支，兩邊的格子才會完全一致 ——
 * 不一致的話轉盤會停在別人的名字上。
 */
export function wheelPool(groups, doubles) {
  const all = toSortedList(groups);
  if (!all.length) return [];
  const used = new Set(Object.values(doubles || {}));
  const left = all.filter(g => !used.has(g.id));
  return left.length ? left : all;
}
