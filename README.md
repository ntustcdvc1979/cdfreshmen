# 大學星攻略 — 現場搶答系統

手機（直式）作答 + 主持人控制台 + 投影統計頁。前端純靜態，架在 GitHub Pages；即時同步用 Firebase Realtime Database。

網址（GitHub Pages 開啟後）：

| 頁面 | 網址 | 誰用 |
|---|---|---|
| 玩家端 | `https://ntustcdvc1979.github.io/cdfreshmen/` | 學生手機 |
| 主持人控制台 | `.../host.html` | 主持人 |
| 投影統計頁 | `.../screen.html` | 投影幕 |
| 題目／組別後台 | `.../admin.html` | 主持人 |

---

## 一、先做這三件事（不做的話網站打不開資料）

### 1. 貼上 Firebase 設定

編輯 [`assets/js/firebase-config.js`](assets/js/firebase-config.js)，把 Firebase 主控台
**專案設定 → 一般 → 你的應用程式 → SDK 設定和配置** 那段 `firebaseConfig` 整個貼進去覆蓋。

務必確認裡面有 **`databaseURL`** 這一行（Realtime Database 才需要，Firestore 的設定不會附）。
如果沒有，到 **建構 → Realtime Database** 頁面上方複製資料庫網址補上。

> 這些金鑰本來就會被瀏覽器下載，不是機密。真正的保護在下面的安全性規則。

### 2. 貼上資料庫安全性規則

Firebase 主控台 → **Realtime Database → 規則**，把
[`database.rules.json`](database.rules.json) 的內容整份貼上並發布。

這份規則做到三件事：

- **正解不會外流**：`/answerKey/{題號}` 平常任何人都讀不到，只有主持人按下「公布答案」
  （寫入 `state/revealed/{題號} = true`）之後才變成可讀。學生開開發者工具也偷不到。
- **截止後不能補答**：`/responses` 只有在 `state.phase === "open"` 且題號相符時才寫得進去。
- **只有主持人能改題目、改狀態、看原始作答紀錄。**

### 3. 建立主持人帳號

Firebase 主控台 → **Authentication → 登入方式** 啟用「電子郵件/密碼」，
再到 **使用者 → 新增使用者** 建一組帳號密碼。這組帳號同時用於 `host.html` 和 `admin.html`。

---

## 二、開啟 GitHub Pages

GitHub repo → **Settings → Pages** → Source 選 `Deploy from a branch`，
Branch 選 `main` / `/ (root)` → Save。等一兩分鐘網址就會生效。

---

## 三、活動前準備

1. 開 `admin.html` 登入。
2. **組別**：按「快速建立 1～N 組」一次建好，或逐一新增、改名、排序。
3. **題目**：可以一題一題新增，也可以用最下面的「批次貼上」一次匯入 ——
   一行一題，用 `|` 分隔：

   ```
   題幹 | A選項 | B選項 | C選項 | D選項 | 正解字母
   ```

   例如：

   ```
   大學的「必修」和「選修」差在哪？|必修可以不修|必修沒修完不能畢業|選修不算學分|兩個一樣|B
   遇到室友作息完全相反，最好的第一步是？|直接搬走|忍到學期末|找時間好好溝通|請家長出面|C
   ```

4. 用 `host.html` 的「顯示玩家端 QR Code」把 QR 存下來，貼到 Canva 簡報上。
5. 測完之後記得按 host.html 的 **「清除所有作答紀錄」**，把測試資料清乾淨。

---

## 四、現場操作流程

主持人在 `host.html`：

| 按鈕 | 做什麼 | 學生手機會 |
|---|---|---|
| **▶ 出題／開放作答** | 把目前選到的題目推給所有人 | 跳出題目與 ABCD，可以按 |
| **■ 截止作答** | 鎖住，但**不公布答案** | 按鈕變灰，顯示「已截止作答」 |
| **🎉 公布答案** | 計算統計並解鎖正解 | 跳出金色大字答案 + 答對／答錯 + 全場分布 |
| **下一題 →** | 直接切下一題並開放作答 | 進入新題目 |
| **🏆 結束並公布排行榜** | 產生各組排名 | 顯示最終排行榜 |

沒有倒數計時 —— 節奏完全由主持人手上的按鈕決定。

**計分方式**：組別答對率 = 該組在所有已公布題目的答對人次 ÷ 作答人次。
同分時比答對人次。這樣人數不一樣的組別也公平。

---

## 五、跟 Canva 怎麼搭

Canva 沒辦法在簡報裡嵌入 GitHub Pages（它的嵌入功能只吃白名單網域），所以採用**雙視窗**做法：

1. **Canva 簡報**負責題目視覺（就是資料夾裡那些 16:9 版面）—— 出題、選項、氣氛。
   封面或角落放上玩家端 QR Code。
2. **`screen.html`** 是另外一個瀏覽器分頁，做成同樣的 16:9 深藍星空風格，
   顯示即時作答人數、公布答案時的長條圖、最後的排行榜。
3. 現場把兩個視窗都開好，用 `Alt+Tab`（或 Mac 的 `Cmd+Tab`）切換：
   - 出題 → 停在 Canva
   - 公布答案 → 切到 `screen.html` 看數據
   - 結束 → 停在 `screen.html` 的排行榜

`screen.html` 按 `F11` 進全螢幕，視覺上跟 Canva 是連續的，觀眾不會發現是兩套系統。

> `screen.html` 需要主持人身分才讀得到統計。在同一個瀏覽器先開 `host.html` 登入過，
> 這頁就會自動沿用登入狀態。

---

## 六、檔案結構

```
index.html              玩家端（手機直式）
host.html               主持人控制台
screen.html             投影統計頁（16:9）
admin.html              題目／組別後台
database.rules.json     Realtime Database 安全性規則
assets/
  css/style.css         全站樣式（深藍星空 + 金色 + 霓虹 ABCD）
  js/firebase-config.js ← 要填的地方
  js/common.js          Firebase 初始化、路徑、計分邏輯
  js/player.js  host.js  screen.js  admin.js
  img/hero.jpg  logo.png
```

## 七、資料庫結構

```
/config/groups/{gid}      { name, order }
/questions/{qid}          { order, text, a, b, c, d }      ← 公開可讀，不含正解
/answerKey/{qid}          "A"                              ← 公布後才可讀
/state                    { phase, qid, revealed:{qid:true} }
/responses/{qid}/{裝置id}  { g:組別id, c:"A", t:時間 }
/stats/{qid}              { A,B,C,D,total,key }            ← 公布時寫入
/leaderboard              { updatedAt, rows:[…] }
```

`phase` 有五種：`idle`（待機）、`open`（開放作答）、`locked`（截止未公布）、
`reveal`（已公布）、`final`（排行榜）。

## 八、已知限制

- 以「一支手機一筆答案」計算，同組多人各自作答。沒有登入驗證，
  同一個人換裝置或清除瀏覽器資料會被當成新的人。這對迎新活動的規模是可接受的。
- 沒有防止有人手動改別人裝置的答案（需要知道對方的隨機 id 才做得到，機率極低）。
- 免費方案的 Realtime Database 同時連線上限 100 人。超過的話到 Firebase 主控台升級成
  Blaze（按用量計費，這種規模幾乎不會產生費用）。
