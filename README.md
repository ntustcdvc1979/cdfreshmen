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

## 一、先做這四件事（不做的話網站打不開資料）

### 1. 把 Firebase 設定放進 GitHub Secret

設定值不進版控 —— `assets/js/firebase-config.js` 已列在 `.gitignore`，
線上版本由 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) 在部署時產生。

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**：

- Name：`FIREBASE_CONFIG`
- Secret：把設定寫成 **一行 JSON**（鍵名要加雙引號）

```json
{"apiKey":"AIza...","authDomain":"xxx.firebaseapp.com","databaseURL":"https://xxx-default-rtdb.asia-southeast1.firebasedatabase.app","projectId":"xxx","storageBucket":"xxx.appspot.com","messagingSenderId":"123456789","appId":"1:123:web:abc"}
```

值在 Firebase 主控台 **專案設定 → 一般 → 你的應用程式 → SDK 設定和配置**。
務必確認有 **`databaseURL`** 這一行（主控台複製的那段有時不含它，
要去 **建構 → Realtime Database** 頁面上方另外複製）。

本機測試的話另外複製一份：

```
copy assets\js\firebase-config.example.js assets\js\firebase-config.js
```

> ⚠️ 這樣做只是讓設定值不出現在 git 紀錄裡。**它仍然會出現在部署後的網頁上** ——
> Firebase 前端 SDK 一定要把金鑰送到瀏覽器才能連線，任何人按 F12 都看得到，
> 這是設計上就無法避免的。所以安全性完全靠下面的第 2、3 步，不要靠藏金鑰。

### 2. 貼上資料庫安全性規則

Firebase 主控台 → **Realtime Database → 規則**，把
[`database.rules.json`](database.rules.json) 的內容整份貼上並發布。

這份規則做到四件事：

- **正解不會外流**：`/answerKey/{題號}` 平常任何人都讀不到，只有主持人按下「公布答案」
  （寫入 `state/revealed/{題號} = true`）之後才變成可讀。學生開開發者工具也偷不到。
- **截止後不能補答**：`/responses` 只有在 `state.phase === "open"` 且題號相符時才寫得進去。
- **答案格式受檢查**：只收 A/B/C/D，而且組別必須真的存在。
- **只有名單上的 UID 能改題目、改狀態、看原始作答紀錄** —— 見下一步。

### 3. 啟用 Google 登入，並把自己的 UID 加進白名單

主持人用 Google 帳號登入，不用另外記密碼。

**但「能登入」不等於「是主持人」。** 任何人都有 Google 帳號，而 API 金鑰是公開的，
所以規則不是看「有沒有登入」，而是看「這個 UID 有沒有在 `/admins` 名單上」。
**這一步不能跳過。**

1. Firebase 主控台 → **Authentication → 登入方式** 啟用 **Google**
   （選一個專案支援電子郵件地址，存檔即可）。
2. **Authentication → 設定 → 授權網域**，確認清單裡有
   **`ntustcdvc1979.github.io`**。沒有的話手動加入，
   否則線上版本按登入會出現 `auth/unauthorized-domain`。
3. 開 `host.html`，用你的 Gmail 按「使用 Google 帳號登入」。
   第一次登入會被擋下來，畫面上會直接顯示你的 **UID** —— 複製它。
4. Firebase 主控台 → **Realtime Database → 資料**，在根目錄手動新增：

   ```
   admins
     └─ 剛才複製的UID :  true      （型別選 boolean）
   ```

5. 回到 `host.html` 重新登入，就進得去了。
6. 全部設定完之後，把 **Authentication → 設定 → 使用者動作** 裡的
   **「啟用建立帳戶（註冊）」關掉**，之後就沒有新帳號能被建立。
   （順序很重要：要先完成第 3 步登入過一次，帳號才會存在。）

要多一位主持人的話，請對方登入一次拿到 UID，再重複第 4 步加進名單即可。
`host.html`、`admin.html`、`screen.html` 三頁共用同一組登入。

### 4.（建議）限制 API 金鑰的來源網域

Google Cloud Console → **API 和服務 → 憑證 → 你的瀏覽器金鑰 → 應用程式限制**
選「HTTP 參照網址」，加入 `ntustcdvc1979.github.io/*`。
這樣就算金鑰被抄走，也沒辦法從別的網站拿來用。

---

## 二、開啟 GitHub Pages

GitHub repo → **Settings → Pages** → Source 選 **`GitHub Actions`**（不是 Deploy from a branch）。

之後每次 push 到 `main`，Actions 會自動把 secret 寫進 `firebase-config.js` 再部署。
第一次可以到 **Actions** 分頁看有沒有跑成功；如果 secret 沒建好，工作流程會直接失敗並告訴你原因。

---

## 三、活動前準備

1. 開 `admin.html` 登入。
2. **組別**：按「快速建立 1～N 組」一次建好，或逐一新增、改名、排序。
3. **題目**：可以一題一題新增（每題可選一個類別），也可以用最下面的「批次貼上」
   一次匯入 —— 一行一題，用 `|` 分隔：

   ```
   題幹 | A選項 | B選項 | C選項 | D選項 | 正解字母 | 類別
   ```

   最後的類別可以省略，省略就是「未分類」。例如：

   ```
   大學的「必修」和「選修」差在哪？|必修可以不修|必修沒修完不能畢業|選修不算學分|兩個一樣|B|時間管理大師
   遇到室友作息完全相反，最好的第一步是？|直接搬走|忍到學期末|找時間好好溝通|請家長出面|C|人際網絡高手
   ```

   只有兩個選項時就少寫兩欄：`題幹|甲|乙|A|親善大使`。

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

## 四之一、題目類別與強項分析

每一題可以歸到六個類別之一，對應主視覺上那六張卡片：

| 類別 | 顏色 |
|---|---|
| 人際網絡高手 | 桃紅 |
| 親善大使 | 金黃 |
| 美食小當家 | 綠 |
| 時間管理大師 | 橘 |
| 情緒管理大師 | 紫 |
| 團隊領航員 | 藍 |

要增減類別或改名，改 [`assets/js/common.js`](assets/js/common.js) 最上面的 `CATEGORIES`。
題目是用 `id` 存的，所以改 `name` 不會弄壞既有資料。

分析結果在兩個地方看得到，都是**一張「組別 × 類別」的答對率矩陣**：

- **金色格子**＝該類別答對率最高的組（直的看：這個類別哪一組最強）
- **藍框格子**＝該組答對率最高的類別（橫的看：這一組最擅長什麼）
- `–` 代表該組在那個類別完全沒作答

`host.html` 的「類別分析」除了矩陣，還把兩個答案直接列成兩欄清單。
`screen.html` 在最終畫面**按空白鍵（或點畫面）可以在排行榜與類別分析之間切換**，
方便主持人講評時對著投影幕講。

學生手機在結束畫面也會看到自己那組的最強項目。

只計算**已公布**的題目 —— 沒公布的題目不會偷偷影響統計。

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
selftest.html           計分與匯入邏輯的自我檢查頁（開起來看有沒有 FAIL）
database.rules.json     Realtime Database 安全性規則
.github/workflows/deploy.yml   部署時注入 Firebase 設定並發布 Pages
assets/
  css/style.css         全站樣式（深藍星空 + 金色 + 霓虹 ABCD）
  js/firebase-config.example.js  範本
  js/firebase-config.js          本機用，不進版控（.gitignore）
  js/common.js          Firebase 初始化、路徑、權限檢查、計分邏輯
  js/player.js  host.js  screen.js  admin.js
  img/hero.jpg  logo.png
```

## 七、資料庫結構

```
/admins/{uid}             true                             ← 主持人白名單，只能從主控台手動改
/config/groups/{gid}      { name, order }
/questions/{qid}          { order, text, a, b, c, d, cat } ← 公開可讀，不含正解
/answerKey/{qid}          "A"                              ← 公布後才可讀
/state                    { phase, qid, revealed:{qid:true} }
/responses/{qid}/{裝置id}  { g:組別id, c:"A", t:時間 }
/stats/{qid}              { A,B,C,D,total,key }            ← 公布時寫入
/leaderboard              { updatedAt, rows:[…] }
```

`phase` 有五種：`idle`（待機）、`open`（開放作答）、`locked`（截止未公布）、
`reveal`（已公布）、`final`（排行榜）。

## 八、已知限制

- **Firebase 金鑰一定是公開的。** 它會隨網頁下載到每支手機，藏不住。
  安全性靠的是資料庫規則 + `/admins` 白名單 + 關閉自行註冊，不是靠金鑰保密。
- 主持人登入用 Google 彈出視窗。被瀏覽器擋掉時會自動改成整頁轉址，
  但 iOS Safari 對轉址式登入的第三方 Cookie 限制較嚴 —— 主持人請盡量用電腦版
  Chrome / Edge，並允許彈出視窗。
- 以「一支手機一筆答案」計算，同組多人各自作答。沒有登入驗證，
  同一個人換裝置或清除瀏覽器資料會被當成新的人。這對迎新活動的規模是可接受的。
- 沒有防止有人手動改別人裝置的答案（需要知道對方的隨機 id 才做得到，機率極低）。
- 免費方案的 Realtime Database 同時連線上限 100 人。超過的話到 Firebase 主控台升級成
  Blaze（按用量計費，這種規模幾乎不會產生費用）。
