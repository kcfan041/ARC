# ARC 先行技術驗證（Spikes）

**相關文件**：`MVP1-PLAN.md`（MVP1 實作計畫）、`REVIEW.md`（規格書審查）
**版本**：草案 v1
**日期**：2026-08-18

---

## 0. 為什麼要先做 Spike

`MVP1-PLAN.md` 的三個核心假設目前都**未經驗證**：

```text
假設 1  可以正確地把「使用者的操作」與「產生的 request」綁定起來
假設 2  宣告式採集規格足以表達使用者的實際需求
假設 3  在反爬站上，通過驗證後的 session 能維持足夠長的時間
```

這三個假設中，**任何一個不成立，MVP1 的設計就需要修改**。

其中假設 2 的影響範圍已因三層架構（`MVP1-PLAN.md` 3.1）而縮小：
它只決定 **agent-facade 這一層**，即「LLM 能協助到什麼程度」。
即使覆蓋率低，人工仍可直接使用 core-tools 的完整能力，
工具本身的能力不受影響。

Spike 的目的**不是寫出可用的程式碼**，而是取得能推翻或支持假設的證據。
所有 Spike 的程式碼預期會被丟棄。

### 執行原則

```text
時間盒     每個 Spike 有明確的時間上限，到點即停並記錄結論
不求完美   只求得到「可以 / 不可以 / 有條件可以」的答案
記錄失敗   失敗的結果與成功同等有價值，必須寫下來
不重構     Spike 程式碼不進入產品，不需要考慮架構
```

### 執行順序

```text
S2  ← 最先做。決定 agent-facade 的設計與 LLM 的實用範圍
S1  ← 其次。影響 Timeline 的核心價值
S3  ← 最後。影響功能優先級，但不影響架構
```

S2 需要專案發起人提供實際目標網站，可與 S1 並行準備。

---

## S1 — Action ↔ Network 綁定正確率

### S1.1 要驗證什麼

`MVP1-PLAN.md` 2.2.A 的核心功能：

> 使用者點擊一個按鈕後，ARC 能正確列出**這個操作導致的**所有 request。

這是 ARC 相對於 Chrome DevTools 的主要差異之一
（DevTools 的 Recorder 面板與 Network 面板不互通）。

### S1.2 為什麼可能失敗

真實網頁存在大量干擾來源：

```text
輪詢          setInterval 定時發出的 request，與使用者操作無關
預載          preload / prefetch / speculative loading
Service Worker 攔截後重新發出，initiator 資訊改變
背景同步      analytics、heartbeat、error reporting
race          使用者快速連續點擊，時間窗重疊
延遲觸發      debounce / throttle 導致 request 在數百毫秒後才發出
async 邊界    await 之後 initiator stack 被截斷
```

### S1.3 做法

**環境**

```text
Playwright + CDP
不需要 UI，輸出到 console 或 JSON 檔即可
```

**步驟**

```text
1. 注入 capture-phase listener 記錄使用者操作
     document.addEventListener('click', handler, true)
     記錄：timestamp、target selector、target 文字

2. 透過 CDP 記錄所有 Network 事件
     Network.requestWillBeSent
     記錄：timestamp、url、method、initiator（含 stack）

3. 實作三種綁定策略，同時執行並比較：

   策略 A  純時間窗
           request 發生在 action 後 N ms 內即綁定
           測試 N = 200 / 500 / 1000 / 2000

   策略 B  時間窗 + initiator 過濾
           排除 initiator.type === 'parser'
           排除 initiator stack 完全落在已知 vendor 檔案的

   策略 C  時間窗 + 週期性偵測
           在 B 之上，額外排除「在使用者操作前就已規律出現」
           的 URL pattern（判定為輪詢）

4. 人工建立 ground truth
     在 5 個網站上各執行 10 個明確操作
     人工判定每個操作「應該」對應哪些 request
```

**測試網站建議**

```text
1 個自建 fixture（已知正確答案，用於驗證測量方法本身）
1 個一般 SPA（例如公開的 React 範例站）
1 個有大量 analytics 的商業網站
1 個有輪詢的網站（即時資料、聊天室、股價）
1 個目標網站（專案發起人實際想抓的站）
```

### S1.4 記錄什麼

對每個策略、每個網站，記錄：

```text
precision   綁定到的 request 中，真正相關的比例
recall      真正相關的 request 中，有被綁定到的比例
最佳時間窗   在測試的 N 值中，哪個表現最好
失敗案例     具體記錄哪些情況綁錯了，原因是什麼
```

### S1.5 判定標準

```text
【通過】precision > 0.8 且 recall > 0.9
        → 綁定可作為 Timeline 的主要功能

【有條件通過】recall 高但 precision 低（抓太多）
        → 可接受。UI 上顯示「可能相關」並允許使用者手動排除
        → 因為漏掉比多抓更嚴重

【不通過】recall < 0.7（經常漏掉真正相關的 request）
        → Timeline 降級為輔助功能
        → MVP1 重心移至「Network 記錄 + LLM 問答 + 採集」
        → 這三項不依賴精確綁定，仍可獨立運作
```

### S1.6 時間盒

```text
2-3 天
```

### S1.7 若失敗的影響

```text
影響範圍：中等
MVP1 的其他部分（觀測、持久化、採集、LLM 問答）不受影響
主要損失是「點 action 看後果」這個體驗

替代方案：
  以時間軸並列顯示 action 與 request，不做自動綁定
  由使用者或 LLM 自行判讀關聯
```

---

## S2 — 宣告式採集規格的覆蓋率

### S2.1 要驗證什麼

`MVP1-PLAN.md` 3.4 的核心設計：

> agent-facade 只接受宣告式規格，不對 LLM 開放 `browser_eval`。

它成立的前提是：

> **宣告式規格足以表達使用者實際想讓 LLM 協助完成的採集需求。**

**影響範圍的界定（重要）**

```text
S2 決定的是「LLM 有多好用」
不決定「工具能做什麼」

即使覆蓋率為 0，人工仍可透過 core-tools
撰寫並執行任意腳本，完成所有採集工作

因此 S2 失敗 → 修改 agent-facade 一層
              不需要重做架構
```

這是三層架構帶來的差異。在原本「限制寫進工具層」的設計下，
S2 失敗會導致整套安全設計重做。

S2 仍排在最先，因為它決定 agent-facade 的介面形狀，
而該介面是 MVP1 中 LLM 層的唯一入口。

### S2.2 為什麼可能失敗

```text
需要多步驟流程     先呼叫 A 取得 id，再用 id 呼叫 B
需要動態 token     每次請求的 token 都不同，且來自前一個 response
游標式分頁         下一頁的 cursor 藏在上一頁的 response 中
需要條件判斷       「如果有 next_page 就繼續，否則停止」
參數在 body 深處   巢狀 JSON 中的欄位，非頂層參數
GraphQL           整個 query 在單一字串參數中
需要呼叫網站函式    參數由前端計算，無法從既有 request 推導
```

其中**游標式分頁與多步驟流程**是最常見的，
若不支援會大幅降低實用性。

### S2.3 做法

**這個 Spike 不需要寫程式碼。是一個紙上分析。**

```text
1. 專案發起人提供 5-8 個實際想抓的網站
   （含至少 2 個有反爬的、2 個一般的）

2. 對每個網站，人工用 Chrome DevTools 完成一次採集
   記錄：
     - 實際發了哪些 request
     - 參數如何變化
     - 資料在 response 的哪個位置
     - 是否需要前一次的結果

3. 針對每個案例，嘗試用宣告式規格表達
   使用 MVP1-PLAN.md 3.4 的格式

4. 對無法表達的案例，記錄：
     - 卡在哪個環節
     - 需要什麼樣的語法擴充才能表達
     - 該擴充是否會破壞 facade 的驗證保證
```

**需要一併設計並測試的擴充**

```text
【chained spec】用前一次結果餵下一批
{
  "steps": [
    { "source_flow": "flow_12", "extract": "$.items[*].id", "as": "ids" },
    { "source_flow": "flow_15", "vary": { "id": { "from_var": "ids" } } }
  ]
}

【cursor 分頁】
{
  "source_flow": "flow_52",
  "paginate": {
    "cursor_param": "after",
    "cursor_from": "$.paging.next_cursor",
    "stop_when": "$.paging.next_cursor == null",
    "max_pages": 20
  }
}

這兩項擴充是否仍能維持
「method / origin / headers 不可變更」的保證？
→ 需在 Spike 中一併確認
```

### S2.4 記錄什麼

```text
對每個採集案例：

  可用基本規格表達            ✓ / ✗
  需要 chained spec           ✓ / ✗
  需要 cursor 分頁             ✓ / ✗
  需要其他擴充（具體描述）      
  完全無法宣告式表達（原因）    
```

### S2.5 判定標準

```text
【通過】≥ 80% 的案例可用「基本規格 + chained + cursor」表達
        → 3.4 的 facade 設計成立，MVP1 照計畫進行
        → browser_eval 維持不對 LLM 開放

【有條件通過】60-80%
        → 設計成立，但 UI 需提供降級路徑：
          「LLM 無法自動處理此情境，以下是手動步驟」
          並引導使用者改用 core-tools 自行完成
        → 記錄實際撞牆頻率，作為日後是否開放腳本的依據

【不通過】< 60%
        → facade 的介面形狀需重新設計（僅此一層）
        → 可能方向：
          (a) 擴充規格語言 → 需注意會逐漸退化成程式語言
          (b) 對 LLM 開放腳本，但加上靜態驗證與人工確認
              → 對應 MVP1-PLAN 8.2 的待決項
          (c) 縮小 LLM 的職責：只做「找出資料在哪」，
              採集動作全部交回人工

★ 三個方向都不影響 core-tools，也不影響人工操作的能力。
```

### S2.6 時間盒

```text
2 天（不含等待專案發起人提供網站清單的時間）
```

### S2.7 若失敗的影響

```text
影響範圍：中等（已因三層架構而縮小）
直接影響 MVP1-PLAN.md 3.4（agent-facade 的介面形狀）
不影響 3.3（core-tools）、不影響人工操作

仍排在最先，因為 agent-facade 是 MVP1 中 LLM 層的唯一入口，
其形狀需在實作前定案
```

---

## S3 — 反爬站的 Session 穩定性

### S3.1 要驗證什麼

`MVP1-PLAN.md` 1.5 與 5.2 的核心主張：

> 使用者用真瀏覽器人工通過 Cloudflare / 登入，
> 之後 ARC 在該 session 中執行採集。

這個主張成立的前提是：

> **通過驗證後的 session 能維持足夠長的時間，
> 且在頁面內發出的 fetch 不會被額外攔截。**

### S3.2 為什麼可能失敗

```text
clearance cookie 有效期短      可能只有數分鐘
每個請求都重新驗證              部分站台對 XHR 有獨立的挑戰機制
fetch 與正常瀏覽被區別對待       缺少 Sec-Fetch-* 或 Referer 會被擋
行為分析                       速率過於規律會被判定為機器
頁面卸載                       導航後 session 可能重建
額外的 header 要求              網站自己的 fetch 帶了特定 header，
                              我們重放時若不完全一致會失敗
```

### S3.3 做法

**環境**

```text
Playwright 啟動有頭瀏覽器
人工操作通過驗證
之後透過 page.evaluate 或 CDP Runtime.evaluate 發出 fetch
```

**步驟**

```text
1. 人工登入 / 通過 Cloudflare

2. 找出一個「網站自己會呼叫的」唯讀 API

3. 在頁面 context 中重放同一個 request
     驗證：能否成功？
     驗證：需要帶哪些 header 才會成功？
           （逐一移除，找出最小必要集合）

4. 測量 session 持續時間
     每 60 秒重放一次
     記錄第幾次開始失敗
     記錄失敗時的 status code 與 response

5. 測量速率容忍度
     以 1 req/sec 連續發送 100 次
     記錄是否觸發 429 或其他阻擋
     若通過，嘗試更高速率找出上限

6. 測試頁面導航後 session 是否仍有效
```

**測試網站**

```text
至少 2 個有反爬的目標網站（由專案發起人提供）
建議涵蓋不同防護類型：
  - Cloudflare 類
  - 自建 token / signature 類
```

### S3.4 記錄什麼

```text
最小必要 header 集合
session 有效時間（分鐘）
1 req/sec 下的連續成功次數
觸發阻擋的速率門檻
導航後是否需要重新驗證
失敗時的具體徵狀（status / body / 是否有明確提示）
```

### S3.5 判定標準

```text
【通過】session 維持 > 30 分鐘，1 req/sec 下 100 次無阻擋
        → MVP1-PLAN.md 的主張成立
        → Session 復原機制可維持在原優先級

【有條件通過】session 維持 5-30 分鐘
        → 主張成立，但 Session 復原必須提前為 MVP1 的高優先項
        → 需設計「session 失效偵測 + 提示使用者重新驗證 + 續傳」
        → 採集規格需支援中斷後從斷點繼續

【不通過】session < 5 分鐘，或 fetch 被獨立挑戰
        → Level 2 在該類網站上不可行
        → 需回頭評估：
          (a) 改為「模擬真實使用者操作」而非 fetch
              （速度更慢，但更難被區分）
          (b) 對這類網站明確標示為不支援
```

### S3.6 時間盒

```text
1-2 天
```

### S3.7 若失敗的影響

```text
影響範圍：中等
不影響架構，但會改變功能優先級與能力邊界宣告

若不通過，MVP1-PLAN.md 5.2 的能力邊界表需要修正，
明確標示哪類網站不支援
```

---

## 附：技術選型的順帶驗證

`REVIEW.md` T5 指出技術選型（TypeScript-only vs Python + Node hybrid）
尚未決定，且建議以 spike 作為決策前置。

上述三個 Spike 若以 **TypeScript + Playwright** 實作，
可順帶取得以下數據，供選型決策參考：

```text
□ Playwright 的 CDP 低階存取是否順手
□ initiator stack 的資料品質（供 MVP2 的 T1 參考）
□ 大型 response body 的處理效能
□ 開發速度的實際體感
```

**建議：Spike 一律用 TypeScript 實作。**

理由：

```text
1. 三個 Spike 都以瀏覽器操作為核心，Playwright 的 Node 版最成熟
2. 即使最終選 Python + Node hybrid，Browser Worker 也是 Node
   → Spike 程式碼的技術棧與該部分一致
3. 可順帶驗證 REVIEW.md 7.3 中對方案 B 的疑慮
   （AST 跨語言序列化問題在 Spike 階段不會遇到，
     但 CDP 存取的順手程度會直接體感到）
```

---

## 執行檢查清單

```text
準備階段
  □ 專案發起人提供 5-8 個實際目標網站（S2 必需）
  □ 其中至少 2 個有反爬（S3 必需）
  □ 建立一個自建 fixture 網站（S1 用於驗證測量方法）

執行階段
  □ S2  宣告式規格覆蓋率        時間盒 2 天
  □ S1  Action↔Network 綁定    時間盒 2-3 天
  □ S3  Session 穩定性          時間盒 1-2 天

收斂階段
  □ 三份 Spike 結論記錄（含失敗案例）
  □ 據此修正 MVP1-PLAN.md
  □ 決定技術選型（REVIEW.md T5）
  □ 若 S2 不通過 → 重新設計 agent-facade 的介面形狀
                    （core-tools 與人工操作不受影響）
```

---

## 結論記錄區

> 執行完成後，將結論填入下方。
> **失敗的結論與成功同等重要，必須完整記錄原因。**

### S2 結論

```text
執行日期：
判定：   □ 通過   □ 有條件通過   □ 不通過
覆蓋率： ___ / ___ 個案例

無法表達的案例：


需要的語法擴充：


對 MVP1-PLAN.md 的修改：
```

### S1 結論

**執行日期**：2026-08-18
**判定**：**有條件通過（conditional）**
**最佳策略**：`C-periodic` 或 `D-rhythm` @ 500ms（兩者同分）
**precision / recall**：**100.0% / 87.5%**
**範圍**：僅 fixture，未含真實網站（依決定先只做 fixture）

#### 前置檢查：時基對齊

寫策略前先驗證，因為時基若偏移 100ms，N=200ms 的時間窗量測即失真。

```text
monotonic→epoch 中位誤差   0 ms
monotonic→epoch 最大誤差   0-1 ms
頁面 vs Node 時鐘差        1 ms
容許上限                  50 ms
→ PASS，量測結果可信
```

#### 策略對照（3 次執行結果穩定）

| 策略 | 最佳窗 | precision | recall | 未過案例 |
|---|---|---|---|---|
| A-window | 200ms | 50-54% | 87.5% | c1,c2,c3,c5,c6,c8,c9 |
| B-initiator | 200ms | 53-58% | 87.5% | c1,c2,c3,c5,c6,c9 |
| **C-periodic** | **500ms** | **100%** | **87.5%** | c9 |
| **D-rhythm** | **500ms** | **100%** | **87.5%** | c9 |

**時間窗**：500ms 為最佳。200ms 會漏掉 c2（debounce 300ms）；
1000ms 以上對 C/D 無增益，對 A/B 則使 precision 進一步惡化至 32%。

#### 主要發現

**1. 週期性偵測是 precision 的關鍵，貢獻遠大於 initiator 過濾**

```text
A → B（加 initiator 過濾）   precision 50% → 54%    +4pt
B → C（加週期性偵測）        precision 54% → 100%   +46pt
```

輪詢會落入每一個操作的時間窗內，是 false positive 的主要來源。
`initiator.type` 過濾幾乎沒有幫助，因為現代網站的請求絕大多數
都是 `type=script`（實測 43/44）。

**2. JS 動態注入的 prefetch 無法用 initiator.type 濾除**

實測發現：由 JavaScript 建立的 `<link rel=prefetch>`，
CDP 回報的 `initiator.type` 是 `script` 而非 `preload` ——
因為它確實是腳本建立的。

解法：改用 `resourceType` 區分（`Other` vs `XHR`/`Fetch`）。
已實作為 `isApiRequest()`。

**取捨**：這會一併濾掉「點擊後載入圖片／影片」這類請求。
對 MVP1 找 API 的用途是正確的，但若日後要支援媒體資源追蹤，
需開放此條件。

**3. c9（輪詢與點擊共用同一端點）是真實的能力邊界**

`urlPattern()` 只保留參數名不保留值，因此輪詢與使用者操作
若共用同一端點，策略 C 無法區分，會把使用者觸發的請求
一併當成輪詢濾掉。

為此實作了策略 D（節奏相位判定）：不整組排除，改為逐一判斷
「這次請求是否落在輪詢節奏上」。原理正確 ——
獨立驗證顯示使用者觸發的請求會產生 −283ms 相位偏移，
明顯偏離節奏。

**但 D 在主量測中仍未通過 c9**，且與 C 同分。原因見下。

#### 測試設計的三個缺陷（已修正，記錄供後續參考）

**缺陷 1：fixture 讓 A/B/C 三者無法區分**

初版所有請求都走 `/api/data`，僅 marker 值不同。
而 `urlPattern()` 只保留參數名 —— 輪詢與點擊觸發因此
collapse 成同一個 pattern，週期性偵測一啟用就會傷及 recall。

結果：A/B/C 三者分數完全相同（precision 63.6%），
看起來像「策略沒有差異」，實際上是 fixture 沒有鑑別力。

修正：雜訊改走獨立端點（`/api/poll`、`/api/prefetch`），
並新增 c9 專門保留「共用端點」這個困難情境。

**缺陷 2：c8 的 prefetch 放在頁面載入時，永遠測不到**

初版把 `<link rel=prefetch>` 寫在 HTML 中，它在所有 action
之前就發生，因此永遠不會落入任何時間窗，
也就永遠不會成為 false positive。策略 B 的價值完全測不出來。

修正：改為點擊後才由 JS 注入。
這個修正同時揭露了發現 2（type=script 問題）。

**缺陷 3：相位掃描的基準點本身是任意的**

`run-c9-sweep.ts` 初版用固定等待（`3000 + phase`）作為基準，
但該基準相對於輪詢週期是任意的，掃描到的相位分佈失真。

初版結果：tolerance 0.25 下 c9 命中 **12/12（100%）**，
與主量測腳本的「c9 失敗」直接矛盾 —— 這個矛盾是發現缺陷的線索。

修正：先等待一次實際的輪詢事件以對齊相位（≈0），再加入偏移。

修正後的真實結果：

```text
tolerance   c9 命中率
  0.15      100%  (12/12)   寬鬆，易把輪詢誤判為使用者觸發
  0.25      100%  (12/12)
  0.35       75%  ( 9/12)
  0.45       58%  ( 7/12)   嚴格，易漏掉使用者觸發

C-periodic  c9 命中 6/12 —— 並非穩定失敗，而是「看相位運氣」
```

#### 尚未解決：C 與 D 的矛盾

```text
相位掃描（隨機相位）    D @ tolerance 0.25  c9 命中 12/12
主量測（固定時序）      D @ tolerance 0.25  c9 失敗

主量測中 c9 的實測相位差為 −117ms，落在容許範圍 225ms 內
→ 被判定為「在節奏上」→ 當成輪詢濾除
```

換言之：**主量測腳本的固定等待時序，恰好讓 c9 落在
節奏容許區內**。這不是 D 的邏輯錯誤，而是單一相位的取樣結果。

**未採取的做法**：調大 tolerance 讓 c9 在主量測中通過。
那是對 fixture 過擬合 —— tolerance 調大會讓真正的輪詢
被誤判為使用者觸發，precision 下降。

**建議**：主量測腳本應改為隨機化各步驟的等待時間並多次執行，
取統計分佈而非單點結果。此項留待 MVP1 實作階段處理。

#### 追加：GUI 原型揭露的週期性偵測缺陷（2026-08-18）

S1 的 fixture 量測沒有暴露這個問題，**因為每個案例只點一次**。
GUI 原型以真實操作驅動時才浮現。

**症狀**

```text
對同一個端點連續點擊三次（間隔 2922ms、1516ms）
→ 三次點擊全部被判定為「輪詢」並濾除
→ Timeline 顯示「無請求」
```

**原因**

`urlPattern()` 會抹除 query 參數的值，因此三次點擊歸為同一組。
接著變異係數計算出 cv=0.317，低於當時的閾值 0.35，
被判定為週期性。

**實測對照**

```text
真實輪詢 /api/poll     n=130  mean= 700ms  cv=0.0010
真實輪詢 /api/shared   n=101  mean= 900ms  cv=0.0010
使用者點擊 /api/data   n=  3  mean=2219ms  cv=0.3168
                                            ↑ 相差三個數量級
```

閾值 0.35 過於寬鬆。

**修正一：收緊閾值**

```text
maxCoefficientOfVariation  0.35 → 0.08   真實輪詢仍有 80 倍餘裕
minOccurrences                3 → 5      三次點擊湊出「規律」的機率不低，
                                         而真實輪詢遠超 5 次
```

**修正二：改用穩健統計（關鍵）**

只做修正一會產生新問題：S1 的 precision 從 100% 掉到 61.5%。

原因是 c9 這類「輪詢與點擊共用端點」的情境 ——
一次點擊會把原本 900ms 的間隔切成兩段（例如 400 + 500），
而標準差對這種離群值極度敏感，
單一次點擊就足以讓整個序列不再被判定為週期性，
該端點的輪詢因此全部湧入綁定結果。

改用中位數為基礎的離散度：

```text
robustDispersion = median(|gap − medianGap|) / medianGap

多數間隔仍是 900ms → 中位數仍是 900ms → MAD 仍接近 0
少數離群值不影響判定
```

職責因此明確分工：

```text
detectPeriodicPatterns  判斷「這個端點有沒有節奏」   ← 用穩健統計
isOffRhythm             判斷「這一次請求在不在節奏上」 ← 用相位偏移
```

**驗證**

```text
修正後 S1 回歸        C/D @ 500ms  precision 100% / recall 87.5%（不變）
GUI 原型重現測試      同端點連點三次 → 3/3 正確綁定
真實操作 4 次點擊     31 flows 中正確濾除 26 筆輪詢，c9 亦正確綁定
```

**教訓**：fixture 的每個案例只點一次，這個設計本身就是盲點。
真實使用必然會重複操作同一個功能。

#### 順帶取得（供 MVP2 參考）

```text
type=script 的 flow      43 / 44
帶 call stack 的 flow    43 / 44
stack 平均深度            2.0

→ initiator stack 的取得率極高，REVIEW.md T1 的
  position mapping 技術路徑在資料面上可行
→ 但平均深度僅 2.0（fixture 無 vendor 層）。
  真實網站經過 axios/fetch wrapper 後深度會顯著增加，
  「跳過 vendor frame 找 app code」的啟發式仍需在真實環境驗證
```

#### 對 MVP1-PLAN.md 的影響

```text
✓ 綁定機制可行，Timeline 維持為核心功能（非降級為輔助）
✓ 預設策略：C-periodic 或 D-rhythm，時間窗 500ms
✓ recall 87.5% 的缺口全部來自 c9 這一類共用端點情境
✓ 依 SPIKES.md S1.5 的「有條件通過」處置：
    UI 應標示「可能相關」並允許使用者手動增減
    因為漏掉比多抓更嚴重

新增的已知限制（應寫入 MVP1-PLAN 8.3 已知妥協）：
  當輪詢與使用者操作共用同一端點且參數名相同時，
  綁定可能漏掉該次操作的請求。
  緩解：UI 提供「顯示被過濾的請求」開關。
```

### S3 結論

```text
執行日期：
判定：   □ 通過   □ 有條件通過   □ 不通過

各測試網站的 session 有效時間：


最小必要 header 集合：


速率門檻：


對 MVP1-PLAN.md 5.2 能力邊界的修改：
```

### 技術選型結論

```text
決定：   □ TypeScript-only   □ Python + Node hybrid   □ 其他
理由：


Spike 過程中支持此決定的觀察：
```
