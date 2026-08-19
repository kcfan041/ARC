# ARC MVP1 實作計畫

**基準文件**：`ai_web_reverse_engineering_agent_project.md`（原規格書，未修改）
**相關文件**：`REVIEW.md`（規格書審查報告）、`SPIKES.md`（先行技術驗證）
**版本**：草案 v1
**日期**：2026-08-18

---

## 0. 本文件的定位

本文件**不取代原規格書**。原規格書描述的是 ARC 的完整願景（59 章、2904 行），
本文件只回答一個問題：

> **第一個版本要做什麼，才能同時滿足「立即可用」與「不走歪路」？**

原規格書的長期目標、Core Tools 架構原則、跨層因果鏈的產品主張，本文件全部保留。
變動的是**開發順序**與**第一版的產出物形式**。

所有變動的理由都記錄在第 1 章與第 4 章，以便日後回溯是否為錯誤判斷。

---

## 1. 為什麼要修正原路線圖

### 1.1 原路線圖的問題

原規格書 §30-§32 的分期是：

```text
MVP1  純靜態分析（無 Chromium、無 GUI 描述、只列 Agent tools）
MVP2  加入 Chromium
MVP3  加入 correlation / evidence / session
LLM   最後才加入
```

這個順序在**單獨看時是合理的**（先建立基礎能力，再往上疊），
但與兩項實際條件衝突。

### 1.2 衝突一：第一版的使用者用不了第一版

專案發起人的實際狀況（本人自述）：

```text
「完全不懂網路架構，會一點點最基礎的網站爬蟲
  （找圖片影片連結、或找很明顯的 api 測試並使用）
  希望這個解析器能抓出我需要的資訊」
```

而原 MVP1 的產出物是：beautified JS、AST、webpack module、
callers/callees、symbol search。

**這些正好是自述中「不會」的那一類操作。**

後果：專案唯一能持續試用的人，在第一版無法試用它。
沒有真實使用回饋，後續三期的設計會建立在推測之上。

### 1.3 衝突二：Human-first 原則被誤讀

原規格書 §42 原則 1（L2023）：

> 所有核心能力必須可由人直接操作。

這句話有兩種讀法：

```text
【讀法 A — 架構原則】✓ 正確，應保留
  所有能力先實作為 Core Tools
  GUI / CLI / LLM Agent 共用同一套 API
  拿掉 LLM 後系統仍完整
  → 這是對的。因為 LLM 要能用，工具本來就得先存在。

【讀法 B — 開發順序】✗ 對本專案不成立
  先做完整的人工 GUI，最後才加 LLM
  → 這是把「工具先於介面」誤讀成「人工介面先於 AI 介面」
```

原規格書 §30-32 採用了讀法 B。

**本計畫採用讀法 A，並明確翻轉開發順序。**

### 1.4 翻轉的技術保證

翻轉開發順序**不等於**放棄 AI-optional。保證方式是模組邊界
（對應 `REVIEW.md` M4）：

```text
packages/
  core-tools/     ← 唯一對外介面，完整能力、零限制
  gui/            → 只能 import core-tools
  cli/            → 只能 import core-tools
  agent-facade/   → 依賴 core-tools，對 agent 只暴露受限介面
  agent/          → 只能 import agent-facade ★ 可整包刪除

強制手段：lint 規則禁止跨層 import
驗收方式：刪除 agent/ 與 agent-facade/ 後，
          gui 與 cli 的所有功能不受影響
```

只要這條邊界成立，「LLM 是可選的」在結構上就是真的，
與它在第幾期被實作無關。

多出來的 `agent-facade/` 這一層，是為了讓「限制只作用於 LLM、
不作用於人工」在結構上成立。完整說明見第 3 章。

### 1.5 衝突三：目標網站有反爬

專案發起人的目標網站「常遇到有反爬的站」
（Cloudflare、需登入、有 signature 或 token 驗證）。

這一項推翻了「把 request 匯出成 Python 程式碼」作為主要產出物的設想：

```text
匯出 Python requests 程式碼
  → 第一次跑可能成功（cookie 還新鮮）
  → 隔天跑 401 / 403
  → 可能原因：token 過期、signature 含 timestamp、
              TLS 指紋不符、缺少 challenge clearance cookie
  → 使用者無法判斷是哪一個

最壞的不是「不能用」，而是「時好時壞、原因不明」
```

原規格書 §21（L1150-1221）其實已經給了正確答案，
只是把它寫成「分析順序」而非「產出順序」：

```text
Level 1  Passive Observation      觀察
Level 2  Browser Context Testing  在網站自己的 runtime 內執行  ★
Level 3  Standalone Request       自行重建 HTTP
```

**Level 2 讓網站自己處理 cookie、signature、token、指紋。**
使用者完全不需要理解那些機制如何運作 —— 這正好對應本專案
發起人的處境。

因此：**MVP1 的主要產出物為 Level 2，而非 Level 3。**

---

## 2. MVP1 範圍定義

### 2.1 一句話目標

> 讓使用者用真實瀏覽器操作網站，ARC 記錄全部過程並持久化，
> 使用者（或 LLM）能據此產生一份受控的採集規格，
> 在該網站自己的 session 中執行，取回結構化資料。

### 2.2 功能清單

#### A. 觀測層

```text
□ 啟動 Chromium（獨立視窗，不嵌入 ARC UI）
□ CDP attach
□ Network Flow 記錄
    request / response、headers、body、timing、initiator
□ Action 記錄
    注入 capture-phase listener 記錄原始手勢
    記錄 target 的 selector / 文字 / 座標
    ★ 不碰框架 handler（見 2.4）
□ Storage diff（cookie / localStorage / sessionStorage）
□ Console / Runtime error
□ Navigation 事件
□ ★ Action ↔ Network 綁定（見 SPIKES.md S1）
```

#### B. 專案持久化層

這是 ARC 相對於 Chrome DevTools 的**結構性差異**（見 2.6）。

```text
□ 專案目錄（SQLite metadata + content-addressed 檔案）
□ 關閉後可重新開啟，所有記錄與註記保留
□ Note / Bookmark（可掛在任何實體上：flow / action / 程式碼位置）
□ ★ Session 保存與復原
    對反爬站是必要功能，非加分項
    記錄 cookie / storage 狀態，可還原至可用 session
```

#### C. 產出層

```text
□ ★ 宣告式採集規格（Collection Spec）— 見第 3 章
□ ★ 三段式執行：Dry-run → Probe → Full
□ ★ 資料回收與抽取（JSONPath / CSS selector）
□ 匯出 CSV / JSON
□ Replay 單一 request + 參數 diff 比對
□ 人工可自由撰寫並執行任意腳本（core-tools 不設限，見 3.3）
□ Level 3 匯出（Python requests / curl）
    ★ 提供，但 UI 需明確標示「在有反爬的網站上可能失效」
```

#### D. LLM 層

能力範圍限定在 `REVIEW.md` 討論中定義的 T1-T2 等級。

```text
□ Side Panel，對當前 context 提問
□ 只能透過 agent-facade 存取（不得直接使用 core-tools，見 3.7）
□ 典型問題：
    「這頁的影片真實網址是什麼」
    「哪個 API 回傳搜尋結果」
    「這些 request 哪些是必要的、哪些是追蹤埋點」
    「這個 API 怎麼翻頁」
    「幫我產生採集這個列表的規格」
□ ★ 每個結論必須附帶 flow_id / action_id，可點擊跳回原始資料
□ ★ 講不出引用來源的結論，UI 標示為「推測」
□ ★ 不得憑空產生 URL / 參數名 / header 值
    —— 由 agent-facade 機械驗證，而非依賴 prompt（見 3.4）
□ ★ browser_eval 不對 LLM 開放（見 3.4 末）
□ 不含 Agent Loop（不自主操作瀏覽器）
```

#### E. 程式碼檢視（最小版本）

```text
□ Beautify（必須產生 position map，見 REVIEW.md T1b）
□ Source map 偵測與套用（見 REVIEW.md L3）
□ 全文搜尋
□ 從 flow 的 initiator 跳至對應程式碼位置
□ 順手支援：讀取本地 JS 目錄（非重點，不為此做額外設計）
```

### 2.3 明確不做

```text
✗ AST parse / module 抽取 / callers / callees / find references
✗ 原規格書 §8 的簡化 pipeline
     constant fold / dead code / string decode / control flow
✗ signature 演算法逆向
✗ Dependency Graph（原規格書 §25）
✗ 完整 Evidence System（原規格書 §24）— 只做 2.2.D 的最小引用機制
✗ Agent 自主操作（原規格書 §38 Agent Loop）
✗ 嵌入式瀏覽器（已確認：MVP1 用獨立 Chromium 視窗）
✗ WebSocket / Download / Upload 深度分析
✗ 對 LLM 開放 browser_eval（人工不受此限，見 3.4）

★ 注意：本清單是「MVP1 不實作的功能」，
  不是「工具禁止的行為」。core-tools 不禁止任何行為（見 3.0）。
```

### 2.4 Action 記錄為何不碰框架 handler

原規格書 §2.0（L121）把「查看 event listener」列為人工操作流程的一環，
但在現代 SPA 上這件事並不成立：

```text
React 17+ 將所有事件委派到 root container
  DOMDebugger.getEventListeners(<button>)  → []（空）
  DOMDebugger.getEventListeners(#root)     → react-dom 內部函式
                                              對所有按鈕回傳同一答案

Vue 3 / Svelte / Angular 各有不同的委派或編譯策略
```

要解決需要 framework adapter（讀 `__reactFiber$xxx` 取 fiber、
再用 `Runtime.getProperties` 的 `[[FunctionLocation]]`），
但這依賴框架內部欄位，每個框架、每個大版本都要維護。

**MVP1 的選擇：不追「哪個 handler 處理了點擊」，
只追「這個點擊導致了什麼」。**

```text
action_41 (click "搜尋")
  ├── POST /api/search          ✓ 可做到
  ├── POST /analytics/event     ✓ 可做到
  ├── DOM diff_192              ✓ 可做到
  └── storage: 無變化            ✓ 可做到

  ← onClick 是哪個 function？MVP3 的 framework adapter 才處理
```

這條路是框架無關的，成本極低，且已覆蓋使用者的實際需求。

### 2.5 Chromium 不嵌入的理由

原規格書 §5.1 的介面草圖把 Chromium 畫在中間欄。
這是 MVP1 最大的單一工程成本來源。

```text
MVP1  開啟獨立的真實 Chromium 視窗
      使用者在真瀏覽器裡自然操作
      在 ARC 視窗中檢視調查結果

後續  確認產品方向後，再評估嵌入是否值得
```

嵌入式瀏覽器是 UX 加分項，不是驗證產品假設的必要條件。

### 2.6 MVP1 相對於 Chrome DevTools 的差異

這一節是 MVP1 範圍設計的核心依據。

**DevTools 已經具備的能力**（因此不構成 ARC 的價值）：

| 能力 | DevTools |
|---|---|
| 記錄使用者操作 | ✅ Recorder 面板 |
| Network 監聽 | ✅ Network 面板 |
| 看 request 的 initiator | ✅ Initiator 欄 |
| 點 initiator 跳到那個 function | ✅ 可直接點擊跳轉 |
| Beautify + 正確定位 | ✅ Pretty-print |
| Source map | ✅ 自動套用 |
| 全文搜尋所有 JS | ✅ Cmd+Shift+F |
| Storage / Console | ✅ |

**DevTools 結構上做不到的**（這才是 ARC 的立足點）：

| 缺口 | 性質 |
|---|---|
| 關掉分頁後一切消失，明天無法接續 | 不累積 |
| Recorder 記操作、Network 記請求，**兩個面板不互通** | 不關聯 |
| 無法查詢「哪個操作導致了對 storage key X 的寫入」 | 不可查詢 |
| 無法對任何東西加註記、書籤、標記 | 不累積 |
| minified 符號改名無法保存 | 不累積 |
| 無法 diff 兩個 request | 不可比較 |
| HAR 匯出會丟失操作綁定、DOM、程式碼脈絡 | 不可攜帶 |
| 無法產生受控的批次採集 | 無產出物 |

**結論：**

> DevTools 是優秀的「即時檢視器」，但是糟糕的「調查工具」，
> 因為它的狀態會蒸發。

因此 MVP1 的重心放在
**持久化、關聯、可查詢、可產出**，
而非重製 DevTools 已有的觀測能力。

---

## 3. 工具、Facade 與預設值

### 3.0 本章的核心原則

> **工具本身不設限。限制屬於 LLM 那一層，不屬於工具。**

這條原則直接來自原規格書自身的邏輯：

```text
§3.1   Core Tools 是底層，Human UI / CLI / LLM Agent 共用同一套
§42-3  三者共用同一套 API

若把限制寫進 Core Tools
  → 人工操作也一併被限制
  → 直接違反 Human-first
```

同時，本章 3.2 的威脅模型指出：**風險來源不是惡意，而是 LLM 會出錯**。
既然問題出在 LLM，解法就必須在 LLM 那一層，而不是在工具層。

參照同類工具的常態：Wireshark、mitmproxy、Burp Suite、Chrome DevTools
都不限制使用者拿它做什麼。ARC 沒有理由不同。

### 3.1 三層架構

```text
┌─────────────────────────────────────────────────────────┐
│  core-tools/                          零限制             │
│                                                         │
│    browser_eval(js)                   執行任意程式碼      │
│    network_replay_with_changes(...)   修改任意欄位        │
│    collect_run(spec | script)         兩種形式皆可        │
│                                                         │
│    唯一的義務：所有操作都記錄到 session                    │
└──────────────┬──────────────────────────┬───────────────┘
               │                          │
               │ 直接使用                  │ 只能透過 facade
               ▼                          ▼
    ┌──────────────────┐      ┌──────────────────────────┐
    │  gui/  cli/      │      │  agent-facade/           │
    │                  │      │                          │
    │  完整能力         │      │  只暴露宣告式介面          │
    │  預設值可覆寫      │      │  驗證 spec 合法性         │
    │                  │      │  拿不到 browser_eval      │
    └──────────────────┘      └────────────┬─────────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │  agent/          │
                                  │                  │
                                  │  只能 import     │
                                  │  agent-facade    │
                                  └──────────────────┘
```

**關鍵：限制必須是結構性的，不能靠 prompt。**

「在 system prompt 裡叫 LLM 不要亂來」沒有用 —— 它不是故意違規，
是會弄錯。因此 agent 套件在**程式碼層面**就拿不到完整工具，
這是 facade 存在的唯一理由。

人工操作（GUI / CLI）直接使用 core-tools，完全不受影響。

### 3.2 威脅模型

MVP1 的主要產出物是「在網站自己的 session 中執行的採集動作」，
以**使用者本人已登入的身分**執行。

需要防範的不是惡意，而是錯誤：

```text
LLM 產生的採集邏輯可能有 bug
  → 迴圈條件錯誤 → 發出上萬次請求
  → 誤判端點性質 → 呼叫了會改變資料的 API
  → 參數推測錯誤 → 觸發網站的異常偵測

而使用者無法從一段 JavaScript 判斷它會做什麼
（本專案發起人自述不熟悉網路架構）
```

注意這個威脅模型的主體是 **LLM**，不是使用者。
人工寫的腳本由人自己負責，工具不介入。

### 3.3 Core Tools：完整能力，零限制

```text
browser_eval(js)
  在頁面 context 中執行任意 JavaScript
  無 method 白名單、無關鍵字比對、無內容類別判定

network_replay(id)
network_replay_with_changes(id, changes)
  可修改任意欄位，含 method / origin / headers / body

collect_run(spec_or_script, options?)
  接受宣告式規格，也接受原始腳本
  options 可覆寫所有預設值（速率、上限、中止條件）

★ 唯一的義務
  所有操作寫入 session 記錄
  這不是限制，而是本工具的核心功能
  （持久化調查專案本來就要記錄每件事）
```

**明確不做的判定**（原草案曾提議，現已移除）：

```text
✗ content-type 是否為媒體串流
✗ URL 或參數的關鍵字風險比對（delete / purchase / ...）
✗ 網域授權宣告狀態
✗ method 白名單

理由：這些都是政策，不是機制。放進工具層會傷害人工操作，
      且刪除後 core-tools 的複雜度顯著下降。
```

### 3.4 Agent Facade：LLM 的受限介面

facade 只對 agent 套件暴露一個執行入口，且只接受宣告式規格。

**宣告式規格格式（草案）**

```jsonc
{
  "source_flow": "flow_52",          // 必須是本 session 實際觀測到的 request
  "vary": {
    "page": { "from": 1, "to": 20 }  // 只有列在這裡的參數可以改變
  },
  "extract": "$.data.items[*].video_url",
  "limit": {
    "max_requests": 20,
    "rate": "1/sec"
  }
}
```

**facade 在轉呼叫 core-tools 前的機械驗證**

```text
✓ source_flow 確實存在於本 session 的觀測記錄中
✓ vary 中的每個參數名，確實存在於原始 request
✓ method   沿用原始 request，LLM 無權指定
✓ origin   沿用原始 request，LLM 無權指定
✓ headers  沿用原始 request，LLM 無權新增或修改
✓ 除了 vary 中明確列出的參數，其餘一律不變
```

**效果**

```text
LLM 在推理與判斷上完全不受限制
但它的輸出在結構上無法呼叫一個
「網站自己沒有呼叫過」的端點

風險上限從「任意程式碼執行」
降至「重放網站自己做過的事，只改變少數參數」
≈ 使用者多點幾次滑鼠
```

**MVP1 決定：`browser_eval` 不對 LLM 開放**

```text
LLM 只能輸出宣告式規格。
人工可在 GUI 中自由撰寫並執行任意腳本。

待 SPIKES.md 的 S2 得出宣告式模型的實際覆蓋率後，
再決定是否以及如何對 LLM 開放腳本能力。
```

### 3.5 GUI 預設值

以下全部是**預設值**，不是限制。人工操作可隨時覆寫。

**區分**：

```text
預設值   幫你少犯錯，隨時可改
限制     不准你做，無法繞過   ← core-tools 中不存在這種東西
```

#### 執行前的呈現

```text
【Dry-run】完全不發送任何請求
  顯示：將送出的完整 request（URL / method / headers / body）
        以及總共會發送幾次
  成本：零

【Probe run】只發送 1 次
  顯示：真實 response
  目的：確認抽取規則是否正確

【Full run】執行剩餘次數
  可隨時中止，即時顯示進度
```

**LLM 產生的規格**：三段順序強制執行。
**人工撰寫的規格或腳本**：可直接跳至 Full run。

當規格來自 LLM 時，確認畫面以自然語言呈現 —— 因為宣告式規格是結構化的，
可以機械翻譯成使用者能判斷的內容：

```text
┌─────────────────────────────────────────────────┐
│ 即將執行                                         │
│                                                 │
│ 重複呼叫   POST /api/search                     │
│           （此端點在你剛才的操作中，              │
│             網站自己呼叫過 3 次）                 │
│                                                 │
│ 只改變     page = 1 → 20                        │
│ 其餘參數   與原始請求完全相同                     │
│                                                 │
│ 總計       20 次請求，每秒 1 次，約 20 秒         │
│                                                 │
│           [ 取消 ]  [ 先跑 1 次 ]                │
└─────────────────────────────────────────────────┘
```

對比：要求使用者判斷 40 行 JavaScript 的安全性 —— 不可行。

#### 預設參數

```text
速率              1 req/sec
單次規格上限       100 requests
單 session 上限    1000 requests
單請求逾時         30s

全部可在執行對話框中即時調整，或於專案設定中變更
```

#### 預設中止條件

**這一項比人工確認更有價值**，因為它不依賴使用者的判斷力：

```text
收到 429 Too Many Requests   → 停止，不重試
收到 403 Forbidden           → 停止
連續 3 次錯誤                 → 停止
response 大小異常暴增         → 暫停並詢問

★ 收到 429 之後仍繼續發送，是「採集」與「攻擊」的實質分界線
  因此這是唯一建議永遠保持啟用的預設值
```

人工模式下可關閉，但 UI 應在關閉時給出明確提示。

#### 免費的安全訊號

```text
若該端點在使用者正常瀏覽時，
網站自己就重複呼叫過多次且參數相同（例如輪詢）
→ 它幾乎確定是唯讀的

★ 這個證據不需要額外發送任何請求就能取得
★ 呈現給使用者作為判斷依據，不作為阻擋條件
```

#### 執行期 UI

```text
永遠可見：
  - 大型停止按鈕
  - 即時計數：已發送 N / 總計 M
  - 目前速率
```

### 3.6 LLM 的自我檢查（agent 層）

以下屬於 agent 套件內部的品質機制，**不是工具層的限制**：

```text
產生規格前，LLM 應自行評估：
  「這個端點看起來會改變資料嗎？」

若判定為可能有副作用
  → 在給使用者的說明中主動標示
  → 但不阻擋執行

★ 讓 LLM 擔任安全顧問，而非只是生成者
★ 刪除 agent 套件後，此機制一併消失，工具行為不變
```

### 3.7 套件邊界與強制手段

這是「AI-optional」與「工具不設限」兩項原則的**技術保證**。

```text
packages/
  core-model/       資料模型與型別，零依賴
  core-store/       SQLite + artifact 檔案儲存
  static-analyzer/  beautify / source map / 搜尋
  browser-runtime/  Playwright + CDP
  correlator/       Action ↔ Network 綁定
  core-tools/       ★ 完整能力，零限制。唯一對外介面

  gui/              → 只依賴 core-tools
  cli/              → 只依賴 core-tools

  agent-facade/     → 依賴 core-tools，對外只暴露受限介面
  agent/            → ★ 只依賴 agent-facade
```

**lint 規則**

```text
禁止  gui, cli          import 除 core-tools 以外的內層套件
禁止  agent             import core-tools（必須經 agent-facade）
禁止  core-tools        import gui, cli, agent, agent-facade
```

**驗收方式**

```text
□ 刪除 agent/ 與 agent-facade/ 後，gui 與 cli 可正常建置與執行
□ lint 能偵測到上述任一違規
□ core-tools 的原始碼中不存在任何「政策判定」邏輯
   （無關鍵字清單、無 content-type 分類、無授權狀態）
```

第三項是本章原則的具體檢查點：**若 core-tools 裡出現了政策，
就代表限制又滲進了工具層。**

### 3.8 限制的上界原則

為避免限制隨著個案討論不斷增生，定下以下硬性規則：

```text
core-tools 不得包含任何政策判定。

任何「在工具層新增限制」的提議，必須先證明：
  (a) 它有客觀的技術訊號可判定，而非猜測網站性質
  (b) 它不影響觀測層
  (c) 它不影響 90% 以上的一般網站
三者缺一則不新增。

★ 即使三者皆滿足，仍應優先考慮實作於 agent-facade 而非 core-tools。
```

**此原則本身比任何單一限制更重要。**

### 3.9 對使用者實際需求的覆蓋檢查

宣告式模型只約束 LLM。人工不受影響。
因此此表檢查的是「LLM 能否協助完成這些工作」：

| 使用者的需求 | LLM 經由宣告式規格 |
|---|---|
| 找出所有圖片 / 影片真實網址 | ✅ **完全不需執行**，只是過濾已觀測的 flow |
| 抓搜尋結果的第 1-20 頁 | ✅ 標準情境 |
| 抓列表中每個項目的詳情 | ✅ 需支援 chained spec（前次結果餵下一批） |
| 匯出成 CSV / JSON | ✅ 與執行無關 |

**目前描述的所有工作流，宣告式模型都覆蓋得到。**

即使覆蓋不到，人工仍可直接使用 core-tools 完成 ——
宣告式模型的覆蓋率只影響「LLM 有多好用」，
不影響「工具能做什麼」。

此假設需由 SPIKES.md 的 S2 實際驗證。
---

## 4. 與原規格書的差異對照

### 4.1 保留

| 項目 | 原規格書 | 說明 |
|---|---|---|
| Core Tools 為唯一介面 | §3.1, §29 | 架構原則，完全保留 |
| GUI / CLI / Agent 共用同一套 API | §42 原則 3 | 保留，並以模組邊界強制 |
| **工具本身不設限** | §3.1 的必然推論 | **本計畫明確化**：限制屬於 agent-facade，不屬於 core-tools。見 3.0、3.8 |
| AI-optional | §2.0 | 保留，但保證方式改為「可刪除 agent 套件」而非「最後才實作」 |
| 跨層因果鏈為核心價值 | §56 | 保留為長期目標，MVP1 只做到 request 層 |
| 觀察優先於偽造 | §42 原則 7 | 保留。對 LLM 由 facade 機械強制；對人工為預設值 |
| UI 操作優先 DOM / Accessibility | §42 原則 8 | 保留 |
| 每個結論保留 evidence | §42 原則 10 | 保留，MVP1 實作最小版本（flow_id 引用） |

### 4.2 翻轉

| 項目 | 原規格書 | 本計畫 | 理由 |
|---|---|---|---|
| LLM 的實作時機 | 最後一期（§30-33） | **MVP1** | 1.2、1.3 |
| 主要產出物 | Level 3 標準 HTTP 請求 | **Level 2 瀏覽器內執行** | 1.5 反爬站 |
| §42 原則 1 的解讀 | 開發順序 | **架構原則** | 1.3 |
| §40 安全邊界的定位 | 工具的使用倫理宣示 | **agent-facade 的結構性限制 + GUI 預設值** | 3.0：政策不屬於機制層 |

### 4.3 降級

| 項目 | 原規格書 | 本計畫 | 理由 |
|---|---|---|---|
| 靜態分析 / AST / module | MVP1 核心 | MVP2 | 使用者不直接使用；T1-T2 任務不需要 |
| §8 簡化 pipeline | MVP1 | MVP3 或更後 | 只在追查 signature 時才需要 |
| Dependency Graph | MVP3 | MVP3 | 維持 |
| 純 JS 目錄模式 | MVP1 主要輸入 | 順手支援 | 已確認非真需求 |
| 嵌入式瀏覽器 | §5.1 主畫面 | 待評估 | 2.5 |

### 4.4 提前

| 項目 | 原規格書 | 本計畫 | 理由 |
|---|---|---|---|
| Level 2 瀏覽器內執行 | §21，未指定期別 | **MVP1 主力** | 反爬站上唯一可靠的路徑 |
| Session 保存與復原 | §27，較後期 | **MVP1** | 反爬站上為必要功能 |
| Evidence 最小版本 | §24，MVP3 | **MVP1** | 見 4.5 |
| Source map | §33 後續進階功能 | **MVP1** | REVIEW.md L3 |
| Replay | §22，未指定期別 | **MVP1** | 使用者的核心工作流 |

### 4.5 Evidence 為何必須提前

原本規劃在 MVP3。此判斷因使用者自述而反轉。

```text
專家能看出 LLM 在胡說
本專案發起人不能 —— 這不是能力問題，是資訊不對稱

若 LLM 說「這個 API 的 sign 參數是 timestamp 的 MD5」
而實際上是編造的
→ 使用者會照著寫程式
→ 花數天不知道為何持續 401
```

因此對這類使用者：

> 「AI 說的每句話都要能一鍵點回原始資料」
> 不是進階功能，是安全機制。

MVP1 不需要完整的 §24 Evidence System，只需最小版本：

```text
LLM 的每個結論必須附帶引用的 flow_id / action_id
  → 點擊直接看到該 request 的真實內容
  → 講不出引用來源的結論，UI 標示為「推測」

實作成本：低（tool call 結果的 id 往回傳）
價值：高
```

---

## 5. 能力邊界宣告

**本節的目的是避免以錯誤的期望評判成果。**

專案發起人的期望是「LLM 加上客製化開發的 tool 可以做到較完整的
逆向工程」。這個期望需要校準 —— 分界線的位置如下。

### 5.1 任務難度分級

| 難度 | 任務 | MVP1 |
|---|---|---|
| T1 | 找出頁面真正的圖片 / 影片 URL | ✅ 純機械過濾，幾乎不需 LLM |
| T1 | 哪個 request 回傳了列表資料 | ✅ |
| T1 | 分辨功能 API vs 追蹤埋點 | ✅ LLM 擅長 |
| T1 | 把 request 轉成 Python / curl | ✅ 但見 5.2 |
| T2 | 分頁參數是哪個、怎麼翻頁 | ✅ replay + diff |
| T2 | token 存在哪、後續怎麼帶 | ✅ storage diff + header 檢查 |
| T2 | 這個 request 是哪段 JS 發的 | ✅ initiator stack |
| T3 | signature / 加密參數怎麼算出來的 | ⚠️ LLM 會編造，需人工介入。MVP3+ |
| T3 | 不開瀏覽器、純 HTTP 重建請求 | ⚠️ 反爬站上經常做不到 |
| T4 | 全自動理解重度混淆的網站 | ❌ 目前沒有工具做得到 |

**專案發起人目前實際在做的事（找媒體連結、找明顯 API 來用）
全部落在 T1-T2。**

這代表 MVP1 就能完整覆蓋現有工作流。
而「較完整的逆向工程」指的是 T3-T4，需要分多期，
且**永遠不會是全自動的**。

### 5.2 反爬站上的具體邊界

| 情境 | ARC 能否處理 |
|---|---|
| Cloudflare 5 秒盾 / Turnstile | ✅ 使用者用真瀏覽器人工通過，之後在該 session 內採集 |
| 需要登入 | ✅ 使用者手動登入，ARC 沿用該 session |
| 有 signature 但使用者不需理解 | ✅ Level 2 讓網站自己計算 |
| 看懂 signature 如何計算 | ⚠️ 半自動，需人工，重度混淆時可能失敗 |
| 脫離瀏覽器、純 Python 長期運行 | ⚠️ 反爬站上經常做不到 |
| 大規模高頻採集 | ❌ 瀏覽器內執行有速率天花板 |
| 繞過驗證碼 / 帳號封鎖 | ❌ 不在範圍內 |

**這張表列的是「技術上做不到什麼」，不是「工具禁止什麼」。**
core-tools 不含任何政策判定（見 3.0、3.8）。

**需特別強調的一項：**

> 如果目標是「寫一支腳本每天自動跑」，
> 那在反爬站上，ARC 給出的答案會是
> **「開著瀏覽器跑」而不是「純 Python 跑」**。
>
> 這是反爬站的本質限制，不是工具能力不足。

---

## 6. 後續分期

### MVP2 — Function 層

```text
目標：把 §56 的因果鏈從 request 層延伸到 function 層

□ AST parse
□ 座標 → 包住它的 function 解析
□ webpack module 抽取、module 邊界
□ callers / callees / find references
□ Artifact 版本鏈與 position mapping（REVIEW.md T1）
□ initiator stack 的 vendor frame 過濾啟發式
□ async stack 深度設定（效能與可觀測性的取捨）

驗收：點擊一個 request，能跳到發出它的 app code function
      （而非 axios 內部）
```

### MVP3 — 調查產出物

```text
□ Dependency Graph（原規格書 §25）
□ 完整 Evidence System（原規格書 §24）
□ 報告匯出
□ WebSocket / Download / Upload
□ Session 匯出匯入（離線再分析）
□ framework adapter（React fiber → onClick handler）
□ §8 簡化 pipeline（含 REVIEW.md T2 的風險等級標註）

驗收：能匯出一份完整的 login flow 報告，每個節點可點擊驗證
```

### MVP4 — Agent Mode

```text
□ Agent Loop（原規格書 §38）
□ 自主操作瀏覽器
□ Investigation State Model 完整版（REVIEW.md T3）

驗收：刪除 agent 套件後，MVP1-3 全部功能不受影響
```

---

## 7. MVP1 驗收標準

對應 `REVIEW.md` M1 指出的「全文無可驗證的完成定義」。

### 7.1 功能驗收

```text
給定：一個需登入、且有基本反爬的目標網站

當：使用者手動登入並執行一次搜尋

則：
  □ ARC 記錄到該次搜尋的 action
  □ Timeline 顯示該 action 觸發的所有 request
  □ 使用者能識別出哪一個是回傳搜尋結果的 API
  □ LLM 能正確指出該 API，並附上可點擊的 flow_id
  □ 使用者能產生一份「翻 5 頁」的採集規格
  □ Dry-run 正確顯示 5 個請求的完整內容
  □ Probe run 成功取回 1 頁真實資料
  □ Full run 完成後可匯出 CSV
  □ 關閉 ARC 後重新開啟，上述所有記錄與註記仍在
```

### 7.2 安全驗收

此節驗收的是 **agent-facade 與 GUI 預設值**，
不是 core-tools 的限制（core-tools 無限制，見 3.0）。

```text
【agent-facade 層】
□ LLM 產生的規格若引用不存在的 flow_id → 執行前被拒絕
□ LLM 嘗試修改 method / origin / headers → 執行前被拒絕
□ LLM 無法取得 browser_eval（型別層面即不存在）

【GUI 預設值】
□ 收到 429 → 預設自動停止且不重試
□ 連續 3 次錯誤 → 預設自動停止
□ 執行期間停止按鈕隨時可用且立即生效
□ 上述預設值皆可由人工覆寫，覆寫後行為符合設定

【人工不受限】
□ 人工可撰寫並執行任意腳本，不經過任何驗證
□ 人工可修改 replay 的 method / origin / headers
□ 人工可跳過 Dry-run / Probe，直接 Full run
```

### 7.3 架構驗收

```text
□ 刪除 agent/ 與 agent-facade/ 後，gui 與 cli 可正常建置與執行
□ lint 規則能偵測到跨層 import 違規
   （含：agent 直接 import core-tools）
□ ★ core-tools 原始碼中不存在任何政策判定邏輯
     無關鍵字清單、無 content-type 分類、無授權狀態、無 method 白名單
□ 所有 LLM 使用的能力，皆有對應的 Core Tool
   且該 Tool 亦可從 GUI 或 CLI 呼叫（且能力更完整）
```

---

## 8. 未解決的問題

### 8.1 需由 SPIKES 驗證

| 問題 | 對應 Spike | 狀態 |
|---|---|---|
| Action ↔ Network 綁定的正確率 | S1 | **✅ 已驗證（2026-08-18）**：有條件通過。C/D 策略 @ 500ms，precision 100% / recall 87.5%（僅 fixture）。Timeline 維持為核心功能 |
| 宣告式規格的覆蓋率 | S2 | 待執行。覆蓋率低則需擴充規格語言，或評估對 LLM 開放腳本 |
| 反爬站上 session 的持續時間 | S3 | 待執行。影響 Session 復原機制的優先級與設計方式 |

**S1 補充**：綁定機制可行，但 recall 缺口全數來自「輪詢與操作
共用同一端點」的情境（已列入 8.3 已知妥協第 5 項）。
另實測發現 initiator stack 取得率 43/44，
支持 REVIEW.md T1 的 position mapping 路徑在資料面可行。
完整結論見 `SPIKES.md` 的 S1 結論區。

**S2 決定「LLM 有多好用」，但不影響工具能做什麼。**

這是三層架構帶來的改變：即使 S2 覆蓋率低，人工仍可直接使用
core-tools 的完整能力完成工作，只是 LLM 的協助範圍縮小。
在原本「限制寫進工具層」的設計下，S2 失敗會導致整套設計重做；
現在它只影響 agent-facade 一層。

### 8.2 尚未決定

```text
✅ 技術選型（REVIEW.md T5）— 已定案 2026-08-18：TypeScript-only
    理由：Playwright / Babel / CDP 同一 runtime，
          AST 不需跨語言序列化（REVIEW.md 7.3 對方案 B 的主要疑慮）
    S1 佐證：CDP 低階存取順手，initiator stack 取得率 43/44

□ LLM Provider 抽象與敏感資料遮蔽（REVIEW.md M5）
    採集到的 response 可能含 token 與個資
    送往第三方 LLM API 前的遮蔽規則尚未設計

□ Chained spec 的格式
    「用前一次結果餵下一批請求」的宣告方式

□ 專案目錄的實際 schema（REVIEW.md T4）

□ 是否以及何時對 LLM 開放腳本能力（見 3.4 末）
    待 S2 結果出爐後決定
```

### 8.3 已知的設計妥協

```text
1. 不追框架 handler（2.4）
   → 「點了按鈕但什麼都沒發生」的情況無法診斷

2. LLM 只能輸出宣告式規格（3.4）
   → 部分複雜情境 LLM 無法協助自動化
   → 但人工可直接使用 core-tools 完成，非能力缺口

3. 速率預設 1 req/sec
   → 大量採集會很慢，但這是預設值而非上限，可調整

4. 獨立 Chromium 視窗（2.5）
   → 使用者需在兩個視窗間切換

5. 輪詢與操作共用端點時，綁定可能漏掉（S1 實測）
   → 當某端點同時被輪詢與使用者操作使用，且參數名相同時，
     週期性過濾可能連同使用者觸發的請求一起濾掉
   → 實測 recall 87.5%，缺口全部來自此情境
   → 緩解：UI 提供「顯示被過濾的請求」開關，
     並依 S1 判定標準將綁定結果標示為「可能相關」

6. 點擊後載入的圖片／影片不會被綁定（S1 實測）
   → 為濾除 JS 動態注入的 prefetch，綁定只保留
     XHR / Fetch / EventSource / WebSocket 類型
   → 對「找出資料來源 API」是正確取捨
   → 但若日後要支援媒體資源追蹤，需開放此條件
```

---

## 附錄：本計畫與原規格書的閱讀順序建議

```text
理解產品定位與長期目標
  → ai_web_reverse_engineering_agent_project.md §1-3, §41, §56

了解規格書的已知問題
  → REVIEW.md

決定第一版做什麼
  → 本文件

開始實作前
  → SPIKES.md（S1-S3 必須先完成）
```
