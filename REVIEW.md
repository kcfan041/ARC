# ARC 規格書審查報告

**審查對象**：`ai_web_reverse_engineering_agent_project.md`（2904 行）
**審查日期**：2026-08-17
**原檔狀態**：未修改。本文件為獨立審查意見，所有建議均以「提案」形式呈現。

> 本文所有行號引用均指向原規格書。格式為 `§章節（L行號）`。
> 原規格書章節編號本身存在錯誤（見 [2.2](#22-s2章節編號全面-off-by-one)），
> 因此本文一律以「原文標示的編號」引用，並在必要時附上行號以消除歧義。

---

## 0. 摘要

### 0.1 整體評價

這份規格書在**產品定位與設計哲學**上的品質相當高。以下幾點是明確的優點，應予保留：

- **Human-first / AI-optional 的立場清晰且一致**（§2.0、§3.1、§42）。明確主張「關閉 LLM 時系統仍須完整可用」，避免了目前多數 AI 工具「拿掉模型就只剩空殼」的通病。
- **§3.2 對 LLM 能力邊界的判斷準確**。把 grep、AST parsing、symbol reference 計算、dependency extraction 劃給傳統程式，把語意理解、假設建立、下一步決策劃給 LLM，這個分工是正確的。
- **§56 找到了真正的差異化點**。市面上 Chrome DevTools、mitmproxy、webcrack、Playwright 各自都很強，但確實沒有工具把 UI Action → JS Function → Bundle Module → HTTP Request → Storage → Re-render 串成同一條因果鏈。這個洞察是整份文件最有價值的部分。
- **§59 對「不要重造輪子」的自覺**、§44-55 對既有專案的調研廣度，都顯示作者對領域有實際理解。

然而，這份文件目前的性質是**產品願景書（Vision Document）**，而非**工程規格書（Engineering Specification）**。它清楚地說明了「要做什麼」和「為什麼」，但幾乎沒有回答「怎麼做」。具體而言：

- 全文列出約 69 個工具名稱，但**沒有任何一個定義了參數型別、回傳結構或錯誤模型**。
- §56 被宣稱為「產品最重要的核心價值」，但**沒有任何一段文字說明它在技術上如何實現**。
- 全文**沒有任何一條可驗證的驗收標準**，也沒有測試策略與非功能需求。

### 0.2 四個 Blocker

以下四項若不先解決，會直接阻擋實作啟動或使核心價值主張無法成立：

| ID | 問題 | 為何是 Blocker |
|---|---|---|
| **T1** | Position Mapping 機制完全缺失 | §56 的 cross-layer 關聯在技術上依賴 runtime 座標與靜態分析座標的對應。beautify 會改變所有行列號，沒有 mapping 就無法把 CDP 的 initiator stack 對到 AST function node。**核心差異化能力直接無法實作。** |
| **T3** | 四套 state model 各自獨立、未統一 | §5.4 Action Timeline、§23 Agent Memory、§24 Evidence System、§25 Dependency Graph 是四組不相干的資料結構。§42 原則 3 要求 GUI/CLI/Agent 共用同一套資料，但沒有定義它們如何合成單一 model。實務後果：人工模式建立的 evidence 無法被 Agent 讀取，反之亦然。 |
| **C3** | Core Tool 只有名稱，沒有簽章 | §3.1 主張「所有功能先以 API 實作、GUI/CLI/Agent 共用」。但沒有 schema 就無法定義共用介面，也無法做 LLM tool-calling。§37 強調 context 控制，卻沒定義任何 response 大小上限或分頁策略。 |
| **L1** | §30 與 §43 對「第一版」的定義互相矛盾 | 兩章描述的 MVP 範圍差距達兩個開發階段，且 §30 的版本違反 §42 原則 12。**無法決定第一版要做什麼。** |

### 0.3 建議處理順序

```text
第 1 步：解決 L1
        決定 MVP 範圍，這是後續所有決策的前提

第 2 步：解決 C3 + T1
        ✅ C3 已於 2026-08-18 解除（MCP Tool 格式 + capabilities）
        T1 仍待處理。原本的理由是「定義簽章時 Artifact/Position
        模型必須同時定案」，但實際實作發現兩者可解耦 ——
        座標型別可作為後續新增的 schema，不阻礙工具契約成立。

第 3 步：解決 T3
        統一 state model，產出 SQLite schema

第 4 步：機械性修復 S1-S4、C1-C2
        圖表、編號、工具清單、命名慣例

第 5 步：補齊 M1-M7
        驗收標準、測試策略、非功能需求等
```

---

## 1. 嚴重度分級與問題總表

### 1.1 分級定義

| 等級 | 定義 |
|---|---|
| **Blocker** | 不解決則無法開始實作，或核心價值主張無法成立 |
| **Major** | 會導致實作方向錯誤、返工，或違反文件自身宣稱的原則 |
| **Minor** | 影響文件可讀性與維護性，但不影響技術判斷 |

### 1.2 問題總表

| ID | 等級 | 問題 | 位置 |
|---|---|---|---|
| **S1** | Minor | §4 第二張架構圖損毀，混入另一張圖的碎片 | L305-338 |
| **S2** | Minor | 章節編號自 §6 起全面 off-by-one，`## 5.1` 出現兩次 | L556 起 |
| **S3** | Minor | §28 整章遺失（27 直接跳 29） | L1461→L1496 |
| **S4** | Minor | §41 與 §57 內容重複；Human-first 原則三處重述 | L1975, L2787 |
| **C1** | Major | §29.1 Core Tools 清單缺 21 個內文已定義的工具 | L1518-1611 |
| **C2** | Minor | 工具命名慣例不統一（前綴有無、domain 歸屬混亂） | 全文 |
| **C3** | ~~Blocker~~ **已解除** | 工具無參數型別、回傳結構、錯誤模型、分頁策略 → 已採用 MCP Tool 格式實作，另加 capabilities 強制機制。見 3.3 末 | 全文 |
| **C4** | Major | ID 命名空間未定義；module id 跨 build 穩定性未答 | 全文 |
| **T1** | **Blocker** | Position Mapping 缺失，§56 無實作方案 | §56 (L2698) |
| **T2** | Major | 簡化 pipeline 破壞 evidence 可驗證性，牴觸 §42 原則 10 | §8, §24 |
| **T3** | **Blocker** | 四套 state model 未統一 | §5.4/23/24/25 |
| **T4** | ~~Major~~ **已解除** | §35 有儲存項目清單但無 schema → 已實作 core-store（node:sqlite）。見 4.4 末 | L1785-1815 |
| **T5** | Major | §34 選型未決，且未評估跨語言 AST 序列化風險 | L1748-1783 |
| **L1** | **Blocker** | §30 與 §43 對第一版定義矛盾；§30 違反 §42 原則 12 | L1615, L2038 |
| **L2** | Major | `browser_eval` 風險高於 replay，卻未納入 §40 保護範圍 | §21, §40 |
| **L3** | Major | Source Map 應在 MVP1 而非「後續進階功能」 | §33 (L1706) |
| **M1** | Major | 缺驗收標準與成功指標 | — |
| **M2** | Major | 缺測試策略（尤其 deobfuscator 語意等價驗證） | — |
| **M3** | Major | 缺非功能需求（效能、容量、截斷策略） | — |
| **M4** | Minor | 缺專案結構與模組邊界定義 | — |
| **M5** | ~~Minor~~ **已解除** | 缺 LLM Provider 抽象層設計 → 已實作 agent-facade，含敏感資料遮蔽。見 6.5 末 | — |
| **M6** | Minor | 缺 License 相容性檢查（§44 建議整合 webcrack） | L2148 |
| **M7** | Major | §40 只有原則性文字，缺技術強制手段 ※**本項建議已被推翻，見 6.7 末的修訂註記** | L1934-1971 |

統計：**4 Blocker、11 Major、8 Minor**。

---

## 2. 結構性錯誤

### 2.1 S1：§4 第二張架構圖損毀

**位置**：L305-338

**問題**：這張圖是複製貼上事故的產物。實際內容如下：

```text
L306-311  ┌─ Tool / Core API ─┐  正常開頭
L313-314  三個框的標籤列：Static Analyzer / Chromium Runtime / Evidence Store
L315-320  ← 斷裂點。突然插入另一張圖的碎片：
              │ - 建立調查目標        │
              │ - 建立假設            │
              │ - 決定下一步工具呼叫   │
              │ - 整理 evidence       │
          這四行顯然屬於一個「Agent Controller」框，
          但該框的標題列已遺失
L322-337  同一組三分支「又完整重畫一次」，這次帶完整內容
```

**影響**：L313-314 的三個框有標籤無內容，L326-337 的三個框有標籤有內容 —— 讀者會困惑這是兩層不同的東西，還是同一層。同時「Agent Controller」這個元件在整份文件的架構圖中**從未被正確呈現過**，儘管 §38 Agent Loop 詳細描述了它的行為。

**建議**：拆成兩張獨立的圖。完整修正稿見[附錄 C](#附錄-c修正後的架構圖)。

---

### 2.2 S2：章節編號全面 off-by-one

**位置**：L556 起

**問題**：H1 與其下屬 H2 的編號自 §6 開始全面脫節。對照如下：

| H1 章節 | 其下 H2 實際編號 | 應為 |
|---|---|---|
| §6 網站資源收集 | `5.1` | `6.1` |
| §7 JavaScript 靜態分析 | `6.1`, `6.2` | `7.1`, `7.2` |
| §8 JavaScript 自動簡化 | `7.1` – `7.5` | `8.1` – `8.5` |
| §9 Chromium Runtime | `8.1` | `9.1` |
| §11 UI 操作策略 | `10.1`, `10.2` | `11.1`, `11.2` |
| §16 Upload 分析 | `15.1` | `16.1` |

**直接後果**：`## 5.1` 在文件中出現**兩次** —— L346「建議主畫面」與 L556「Resource Collector」。任何交叉引用或目錄產生器都會出錯。

**次要問題**：
- **§1 是 H2（`## 1. 專案概述`），§2-59 全是 H1**。層級不一致。
- 多處 H2 完全沒有編號：§21 的 Level 1-3、§25 的 Node/Edge Types、§26 的三個查詢範例、§33 的四個進階功能、§34 Backend、§39 的四個輸出區塊、§53 的方案 A/B。
- §29.1 底下的 9 個分類（Files/Code、AST、Simplification…）標為 H2，與 §29.1 同級，但語意上應為 H3。

完整重編號對照表見[附錄 A](#附錄-a章節重編號對照表)。

---

### 2.3 S3：§28 整章遺失

**位置**：L1461 §27 Session Recording → L1496 §29 共用 Tool API

**問題**：§28 不存在。無法判斷是編號跳號，還是有一章在編輯過程中被刪除。

**觀察**：從 §27（Session Recording）到 §29（共用 Tool API）之間，內容上缺少一個銜接。文件在 §23-27 講完 Agent Memory、Evidence、Graph、查詢範例、Session Recording 之後，直接跳到 Tool API 定義。一個合理的 §28 候選主題是 **「Investigation / Project 資料模型」** —— 這正好是 T3 指出的缺口。

**建議**：確認是否有遺失內容。若無，建議將 §28 用於補上統一的 Investigation State Model（見 [4.3](#43-t3四套-state-model-未統一)）。

---

### 2.4 S4：內容重複

**問題**：

1. **§41「專案定位」（L1975）與 §57「產品定位更新」（L2787）幾乎逐句重複**。兩者都在講「不應只被定位成 AI Browser Agent / JavaScript Deobfuscator，而是 ARC」、都在列「核心 Human-operated + 附加 AI-assisted + 進階 Agent-driven」。§57 標題雖為「更新」，但內容並未實質更新 §41，只是換句話說。

2. **Human-first / AI-optional 原則在三處重述**：§2.0（L108-185）、§3.1（L206-241）、§42（L2021-2035）。

3. **§44-55 的專案借鑑清單與 §58「建議優先研究順序」重疊**。§58 只是把 §44-55 已經講過的專案再排一次序，沒有新增資訊。

4. **§30/31/32（MVP 三版）與 §43（最小可行產品定義）重疊**，且互相矛盾（見 [5.1](#51-l1mvp-定義矛盾)）。

**影響**：文件約 2904 行，合併重複段落後估計可壓縮 **20-25%** 而不損失任何資訊。過長且重複的規格書會降低實際被閱讀與遵循的機率。

**建議**：
- 刪除 §57，將其中「三者共用 Core Tools / Evidence / Investigation Graph / Session Data」這一句（L2823-2830，§41 沒有的部分）併入 §41。
- §2.0 保留完整論述；§3.1 改為引用 §2.0 並只保留架構圖；§42 保留為 checklist 形式（它的價值在於「可逐條檢查」）。
- §58 併入 §55，改為在 §55 的組合圖上直接標註優先級。

---

## 3. 一致性缺陷

### 3.1 C1：§29.1 Core Tools 清單與內文嚴重不同步

**位置**：L1518-1611

**問題**：§29 宣稱「所有底層功能應先定義成共用 Tool API」，是全文唯一的工具總表。但它與內文各章定義的工具存在雙向落差。

**內文已定義，§29 卻遺漏（21 個）**：

| 工具 | 內文位置 | 所屬分類 |
|---|---|---|
| `list_resources` | §6 (L577) | Resource |
| `get_html` | §6 (L578) | Resource |
| `get_script_urls` | §6 (L579) | Resource |
| `download_resource` | §6 (L580) | Resource |
| `get_source_map` | §6 (L581) | Resource |
| `list_dynamic_chunks` | §6 (L582) | Resource |
| `get_imports` | §7.2 (L641) | AST |
| `get_exports` | §7.2 (L642) | AST |
| `find_callees` | §7.2 (L646) | AST |
| `normalize_control_flow` | §8.5 (L721) | Simplification |
| `rename_known_runtime_symbols` | §8.5 (L722) | Simplification |
| `browser_click_text` | §11.2 (L807) | Browser |
| `mouse_move` | §11.2 (L817) | Browser |
| `mouse_click` | §11.2 (L819) | Browser |
| `mouse_drag` | §11.2 (L821) | Browser |
| `network_find_by_url` | §14 (L906) | Network |
| `storage_diff` | §19 (L1107) | Storage |
| `console_list` | §20 (L1139) | Console |
| `runtime_get_errors` | §20 (L1141) | Console |
| `ws_find_message` | §18 (L1068) | WebSocket |
| `network_replay` / `network_replay_with_changes` | §22 (L1230-1235) | Network |

其中 **Resource Collector 整組 6 個工具**與 **Console 整個分類**在 §29 中完全消失 —— 而 Resource Collector 是 §43 MVP 流程的第 2 步，Console 是 §43 MVP 流程第 6 步要記錄的項目之一。

**§29 有列，但內文從未定義（4 個）**：

```text
list_files      ← 與 list_resources 的關係未定義
read_file       ← 與 read_code 命名衝突（見下）
search_code     ← MVP1 的核心工具，卻無任何說明
upload_file     ← §16 只講 Playwright 的 setInputFiles，未定義此工具
```

`search_code` 尤其值得注意：它在 §30 MVP1 的工具清單中位居第一，是「不讓 LLM 吃完整 bundle」（§42 原則 4）的關鍵機制，但全文對它的搜尋語法、範圍限制、回傳格式**零說明**。

**命名衝突**：

```text
§29.1 (L1524)  read_file
§30   (L1640)  read_code
```
同一個工具在兩章有兩個名字。

**建議**：以內文為準反向收斂，重寫 §29.1。完整清單見[附錄 B](#附錄-bcore-tools-完整收斂清單)。

---

### 3.2 C2：命名慣例不統一

**問題**：全文 69 個工具存在四種不一致：

**(a) 前綴有無不一致**

```text
有 domain 前綴：  network_list, browser_click, ws_list
無 domain 前綴：  get_module, find_callers, beautify_js, constant_fold
```
AST 與 Simplification 兩個分類完全沒有前綴，Browser/Network/WebSocket 則有。

**(b) domain 歸屬混亂**

```text
browser_get_cookies         ← 前綴是 browser，但 §29 歸類在 Storage
browser_get_local_storage   ← 同上
storage_diff                ← 同一分類卻改用 storage 前綴
```
Storage 分類下的 5 個工具用了 2 種前綴。

**(c) 動詞順序不一致**

```text
network_list       ← domain_verb
list_resources     ← verb_domain
list_functions     ← verb_domain
get_downloads      ← verb_domain（但 §29 分類叫 Download）
ws_list            ← domain_verb
```

**(d) 單複數不一致**

```text
network_list      → 回傳列表，單數命名
get_downloads     → 回傳列表，複數命名
ws_list           → 回傳列表，單數命名
console_list      → 回傳列表，單數命名
```

**影響**：
- LLM tool-calling 時，不一致的命名會顯著增加模型選錯工具的機率。這對 §42 原則 3（三種介面共用同一套 API）有實質傷害。
- 人工使用 CLI 時難以記憶與推測。

**建議**：統一為 `<domain>_<verb>[_<object>]`，全部使用單數動詞。對照見[附錄 B](#附錄-bcore-tools-完整收斂清單)。

---

### 3.3 C3：工具缺少簽章定義【Blocker】

**問題**：全文 69 個工具，**沒有任何一個定義了以下任一項**：

```text
□ 參數型別與必要性
□ 回傳資料結構
□ 錯誤模型（找不到 / 逾時 / 權限不足 / 目標已失效）
□ 同步或非同步語意
□ 回傳大小上限與截斷策略
□ 分頁機制
□ 冪等性
```

**為何是 Blocker**：

1. **直接牴觸 §3.1 的核心主張**。文件宣稱「所有重要功能都應先以 API/Tool 方式實作，之後 GUI、CLI、LLM Agent 都可以呼叫」。但沒有 schema，「共用同一套 API」就只是口號 —— 三個 caller 會各自對回傳格式做出不同假設。

2. **與 §37 Context 控制直接衝突**。§37 說「LLM 只取得目前任務所需要的程式碼」，但如果 `get_module(4278)` 回傳的是一個 500KB 的 minified module，這條原則就自動失效。**截斷與分頁策略必須是工具簽章的一部分**，不能靠呼叫端自律。

3. **無法做 LLM tool-calling**。OpenAI / Anthropic 的 function calling 都要求 JSON Schema。沒有型別定義就無法產生 tool spec。

**具體風險範例**：

```text
network_get_response_body(id)
    → HTTP response body 可能是 50MB 的 JSON、或 binary
    → 沒有定義：是否截斷？截斷後如何取得剩餘部分？
    → binary 如何表示？base64？還是回傳一個 artifact 參照？

browser_get_dom()
    → 複雜 SPA 的 DOM 可達數 MB
    → 沒有定義：回傳完整 HTML？還是 §11.1 建議的 Accessibility Tree 摘要？
    → 沒有 selector 參數可縮小範圍

find_references(symbol)
    → 一個常見 symbol 在 bundle 中可能有數千個 reference
    → 沒有定義：分頁？上限？排序規則？
```

**建議**：新增「§29.2 Tool 簽章規範」，統一定義：

```typescript
// 建議的統一回傳信封
type ToolResult<T> = {
  ok: true
  data: T
  truncated?: {
    reason: "size_limit" | "count_limit"
    returned: number
    total: number
    cursor?: string        // 用於接續取得
  }
} | {
  ok: false
  error: {
    code: ToolErrorCode    // 列舉，非自由字串
    message: string
    retryable: boolean
  }
}

type ToolErrorCode =
  | "NOT_FOUND"            // artifact / request / module 不存在
  | "STALE_REFERENCE"      // 目標曾存在但 session 已失效
  | "TIMEOUT"
  | "PERMISSION_REQUIRED"  // 對應 §40 的高風險操作確認
  | "PARSE_FAILED"
  | "BROWSER_NOT_READY"
  | "INVALID_ARGUMENT"
```

同時應定義**全域預設**：

```text
單次回傳上限        建議 256 KB（可由呼叫端覆寫）
列表類預設筆數      建議 100
超限行為            回傳 truncated 而非拋錯
大型內容            回傳 artifact_id，由 read_artifact 分段取得
```

---

> **【已解除 2026-08-18：C3 Blocker】**
>
> 採用 **MCP（Model Context Protocol）** 的 Tool 格式作為簽章契約，
> 實作於 `packages/core-model/src/tool.ts` 與 `packages/tool-runtime/`。
>
> **已實作的項目**：
>
> ```text
> ✓ 參數型別        inputSchema（JSON Schema）
> ✓ 回傳結構        outputSchema
> ✓ 錯誤模型        ToolErrorCode 列舉，非自由字串
> ✓ 統一信封        ToolResult<T> = { ok, data, truncated } | { ok, error }
> ✓ 分頁機制        truncated.cursor
> ✓ 全域預設        TOOL_LIMITS（256KB / 100 筆 / 30s）
> ✓ 逾時保護        Registry.call 強制套用
> ```
>
> **超出本節原建議的部分** —— 新增了 `capabilities` 機制：
>
> 本節原本只要求「工具要有簽章」。但在工具可由 AI 生成或外部匯入的
> 前提下，簽章不足以構成安全性。MCP 規格明文要求
> `annotations`（readOnlyHint 等）**必須視為不可信**，
> 因為那是工具的自述。
>
> 因此另立一套強制機制：
>
> ```text
> annotations    工具自述 → 不可信 → 僅供 UI 與 LLM 參考
> capabilities   宣告 + 執行期注入 → 強制 → 決定實際拿得到什麼
> ```
>
> 未宣告的能力不是「被禁止」，而是**不存在於作用域**。
> 已於 QuickJS 實測驗證：
>
> ```text
> network_list  → "function"    已宣告
> browser_eval  → "undefined"   未宣告，不存在
> ```
>
> 這符合 `MVP1-PLAN.md` 3.8 的上界原則 ——
> 最小權限是機制，不是行為黑名單。core-tools 本身仍零限制。
>
> **驗收**：`npm run tools:check` 共 30 項，全數通過。
> 設計說明見 `MVP1-PLAN.md` 第 3A 章。

---

### 3.4 C4：ID 命名空間未定義

**問題**：全文散落各種 ID，但沒有統一定義：

```text
req_12, req_52, req_812, req_813, req_102   §5.7, §14, §15, §48
action_12 ~ action_17, action_41, action_42  §5.4, §15, §26
diff_192                                     §15
storage_diff_9, diff_9                       §24, §39
module 4278, module 1827, module 8271        §5.6, §24, §56
function_id                                  §7.2
connection_id                                §18
```

**未回答的關鍵問題**：

| 問題 | 為何重要 |
|---|---|
| module id 跨 chunk 是否唯一？ | webpack 的 module id 在不同 chunk 中可能重複；`get_module(4278)` 缺少 chunk 限定就有歧義 |
| **module id 跨 build 是否穩定？** | webpack 預設的 numeric id 會隨 build 改變。網站重新部署後，昨天記錄的 `module 4278` evidence 今天可能指向完全不同的程式碼 |
| 跨 session 是否穩定？ | §27 Session Recording 要求「之後可以離線問」，若 id 不穩定則歷史 session 無法與新的靜態分析結果關聯 |
| `diff_192` 與 `storage_diff_9` 是同一命名空間嗎？ | §15 用 `diff_192` 指 DOM diff，§24 用 `storage_diff_9` 指 storage diff，§39 又寫成 `storage_diff_9`。前綴規則不明 |
| function_id 如何產生？ | 匿名函式、箭頭函式、IIFE 佔 minified code 的大宗，無法用名稱識別 |

**module id 穩定性是最嚴重的一項**。它直接影響 §24 Evidence System 的可信度：

```text
Evidence:
  main.js / module 1827 / function saveSession()
       ↑
  若網站重新部署，這條 evidence 靜默失效
  但系統無法察覺，會繼續顯示為有效證據
```

**建議**：新增 ID 命名空間定義，並區分兩類識別碼：

```text
【Session-scoped】僅在單次 session 內有效
  action_*, req_*, ws_*, diff_*, console_*
  → 存入 session recording，跨 session 不保證意義

【Content-addressed】跨 build 穩定
  artifact_id  = sha256(raw bytes) 前 12 碼
  module_ref   = artifact_id + chunk_name + module_id
  function_ref = artifact_id + AST path（如 "body.3.declarations.0.init"）
                 而非行號，因行號會被 beautify 改變

【建議額外記錄】用於偵測失效
  evidence 應同時存 artifact_id 與擷取時的 content hash
  當網站重新部署導致 hash 不符時，evidence 應標記為 "stale"
  而非靜默失效
```

其中 `function_ref` 使用 AST path 而非行號，是解決 T1 的前置條件之一。

---

## 4. 技術缺口

### 4.1 T1：Position Mapping 機制缺失【Blocker】

**這是本份審查中最重要的一項。**

**背景**：§56（L2698-2783）宣稱以下這條鏈是「整個產品最重要的核心價值」：

```text
UI Action → DOM Event → JavaScript Function → Webpack Module
          → Request Builder → HTTP Request → Response
          → State/Storage Update → Component Re-render → DOM Change
```

**問題**：全文**沒有任何一段說明這條鏈在技術上如何建立**。§56 從頭到尾都是示意圖與願景描述。

**實際技術路徑**：要把一個 HTTP request 對應回 JS function，唯一可行的路徑是 CDP 的 initiator stack：

```text
CDP: Network.requestWillBeSent
  └─ initiator.stack.callFrames[]
       ├─ scriptId          ← Chromium 內部 ID，session-scoped
       ├─ url               ← 例如 https://x.com/_next/static/chunks/main-a3f2.js
       ├─ lineNumber        ← 原始 minified 檔案中的行號
       └─ columnNumber      ← 原始 minified 檔案中的列號
```

而靜態分析這一側，經過 §8 的處理鏈之後：

```text
raw.js（1 行、2.4 MB）
  └─ beautify_js         → beautified.js（48,000 行）
      └─ constant_fold    → 部分節點被替換
      └─ remove_dead_code → 部分行被刪除
      └─ inline_wrappers  → 結構改變
      └─ normalize_webpack_modules → 拆成多個 module 檔案
```

**核心矛盾**：CDP 給的是 `(raw.js, line 1, column 1847293)`，而使用者在 GUI 看到的是 `module 4278 的第 23 行`。**兩者之間沒有任何對應機制。**

**次生問題**：§59（L2876-2891）明確建議「MVP 不要自行實作 basic JavaScript beautifier」。這條建議在單看時很合理，但它與 T1 衝突 —— **多數現成的 beautifier（js-beautify、prettier）不產出 source map**。要建立 position mapping，beautify 這一步必須產生座標對應，這會實質限制工具選擇：

```text
可產生 source map 的路徑：
  ✓ Babel（generator 支援 sourceMaps: true）
  ✓ SWC（支援）
  ✓ recast（保留原始格式資訊）
  ✗ js-beautify（純文字處理，無 source map）
  ✗ prettier（有 --no-semi 等格式化能力，但不吐 source map）
```

**建議**：新增專章「Artifact 版本鏈與 Position Mapping」，定義：

**(1) Artifact 版本鏈**

```text
每個 JS 檔案在系統中以「版本鏈」形式存在：

artifact_v0  raw            從網路取得的原始 bytes（永不修改，evidence 的最終依據）
    │        └─ sourcemap_0 若網站公開 source map，可直接跳到 v3
    ▼
artifact_v1  beautified     必須帶 v1→v0 的 position map
    ▼
artifact_v2  simplified     必須帶 v2→v1 的 position map
    ▼
artifact_v3  modularized    必須帶 v3→v2 的 position map + module 邊界

任意版本的座標都可經由 map 鏈往回解析到 v0
```

**(2) 統一座標型別**

```typescript
type SourcePosition = {
  artifact_id: string      // 內容定址，見 C4
  version: 0 | 1 | 2 | 3
  line: number
  column: number
}

type ResolvedPosition = SourcePosition & {
  // 解析後額外提供
  raw: { line: number; column: number }   // 回推至 v0
  module_ref?: string                      // 若可判定所屬 module
  function_ref?: string                    // 若可判定所屬 function（AST path）
}
```

**(3) 關聯建立流程**

```text
Network.requestWillBeSent
  → initiator.stack.callFrames[0]
  → (url, line, column)
  → 用 url 查 artifact_id                    【需維護 url → artifact 對照】
  → 得 SourcePosition{ version: 0 }
  → 經 position map 鏈正向解析至 v3
  → 用 AST range 查詢包含該座標的最內層 function node
  → 得 function_ref + module_ref
  → 寫入 Investigation Graph 的 SENDS_TO edge
```

**(4) 對 §59 的修訂建議**

§59 應改為：

```text
不要自行實作 JavaScript parser 與 AST format（Babel/SWC 已足夠）
但 beautify 這一步必須選擇「能產出 position map」的方案
建議直接用 Babel/SWC 的 generator（sourceMaps: true）
而非 js-beautify / prettier
```

---

### 4.2 T2：簡化 pipeline 破壞 evidence 可驗證性

**位置**：§8（L651-724）與 §24（L1296-1318）的衝突

**問題**：§8 定義的所有簡化操作都會改變程式碼結構：

```text
constant_fold()              改變運算式節點
remove_dead_code()           刪除整段程式碼
inline_simple_wrappers()     改變函式邊界
decode_string_array()        替換字串字面值
normalize_control_flow()     重組控制流
rename_known_runtime_symbols() 改變識別字
```

而 §24 要求每個結論附上 evidence，格式為：

```text
Evidence:
  main.js
  module 1827
  function saveSession()
  line / AST node        ← 問題在這裡
```

**衝突**：若 evidence 記錄的是**簡化後**的行號，那麼：
- 使用者無法在原始檔案中驗證該證據
- 簡化 pipeline 一旦升級（例如新增一條 transform 規則），所有既有 evidence 的行號全部失效
- 這直接牴觸 §42 原則 10「每個重要結論儘量保留 evidence」的意圖 —— 不可驗證的 evidence 不是 evidence

**更根本的問題**：§8 的簡化操作**沒有定義語意保證**。例如：

```js
// remove_dead_code 的風險
if (typeof window !== 'undefined') { ... }   // 靜態分析可能誤判為 dead code
                                              // 但這在 SSR/CSR 分支中是活的

// decode_string_array 的風險
// 若 string array 在 runtime 被動態改寫，靜態 decode 會得到錯誤結果

// constant_fold 的風險
const x = 0.1 + 0.2;   // 折疊成 0.30000000000000004 還是 0.3？
```

一個會改變程式語意的簡化，會讓建立在其上的所有分析結論失效，且**沒有機制能偵測這件事**。

**建議**：

1. **evidence 一律以 v0 raw 座標儲存**，顯示時才即時解析到使用者當前檢視的版本。這樣簡化 pipeline 升級不影響歷史 evidence。

2. **每個 transform 標註語意風險等級**：

```text
【safe】保證語意等價，可預設啟用
  beautify（純格式）
  rename_known_runtime_symbols（純改名，需確認無 eval / with）

【likely-safe】絕大多數情況等價，預設啟用但可關閉
  constant_fold（需排除浮點數與 BigInt 邊界）
  inline_simple_wrappers

【unsafe】可能改變語意，預設關閉、需明示啟用
  remove_dead_code
  decode_string_array（若涉及動態改寫）
  normalize_control_flow
```

3. **evidence 記錄產生時的 pipeline 設定**，使結論可重現：

```json
{
  "evidence_id": "ev_9",
  "position": { "artifact_id": "a3f2c1", "version": 0, "line": 1, "column": 1847293 },
  "viewed_as": { "version": 3, "pipeline_hash": "p_7d21" },
  "pipeline": ["beautify", "constant_fold", "normalize_webpack_modules"]
}
```

---

### 4.3 T3：四套 state model 未統一【Blocker】

**問題**：文件在四個章節分別定義了四組資料結構，彼此**沒有任何交集定義**：

| 章節 | 結構 | 形式 |
|---|---|---|
| §5.4 (L428) | Action Timeline | `action_12 / Human Click / "搜尋"` |
| §23 (L1263) | Agent Memory | JSON blob：goal / hypotheses / discovered / todo |
| §24 (L1296) | Evidence System | 文字格式：Conclusion + Static Evidence + Runtime Evidence |
| §25 (L1322) | Dependency Graph | Node types（11 種）+ Edge types（9 種） |

**衝突點**：

1. **§42 原則 3 要求三種模式共用同一套資料**（L2025），但 §23 明確是「Agent 的」工作記憶，§5.4 明確是「人工操作的」timeline。若人工模式建立的 evidence 存在 §24 的結構、Agent 建立的存在 §23 的 JSON blob，兩者無法互通。

2. **§42 原則 11 說「Agent 必須維護 investigation state，但人工模式不依賴它」**（L2033）。這句話實際上**承認了兩套 state 並存** —— 但這與原則 3 矛盾。若真的兩套並存，那麼 §5.7「LLM Side Panel 取得目前人工操作的 context」（L536）就無法實作，因為人工 context 不在 Agent 的 state model 裡。

3. **§25 的 Graph 與 §24 的 Evidence 關係未定義**。Graph 的 edge（例如 `handleLogin --CALLS--> authService.login`）是否需要 evidence 支撐？信心度存在 node 上還是 edge 上？§39 輸出 Confidence，§23 的 hypothesis 也有 confidence —— 這兩個是同一個嗎？

4. **Hypothesis 與 Finding 的關係未定義**。§23 有 hypotheses（帶 confidence），§29 有 `add_finding` 與 `update_hypothesis` 兩個工具，但 finding 與 hypothesis 的差別、以及 hypothesis 如何「畢業」成 finding，全文未說明。

**建議**：統一為單一 Investigation State Model。核心概念：

```text
Investigation（調查）
 ├─ 不區分「人工建立」或「Agent 建立」，只記錄 created_by
 ├─ Session[]         實際的瀏覽器工作階段
 │   ├─ Action[]      人工或 Agent 的操作，統一為 action_*
 │   ├─ NetworkFlow[] 借鑑 mitmproxy 的 Flow 概念（§48）
 │   ├─ Diff[]        DOM / Storage 快照差異
 │   └─ ConsoleEntry[]
 ├─ Artifact[]        JS/HTML 版本鏈（見 T1）
 │   ├─ Module[]
 │   └─ Function[]
 ├─ Node[] / Edge[]   §25 的 Graph，node 可指向上述任一實體
 ├─ Claim[]           統一 Hypothesis 與 Finding
 │   ├─ status: hypothesis | supported | refuted
 │   ├─ confidence: 0..1
 │   └─ Evidence[]    每條 evidence 指向 Action / Flow / Position
 └─ Note[]            人工註記、rename 記錄
```

關鍵設計決策：

```text
1. Hypothesis 與 Finding 合併為 Claim，用 status 區分
   → 消除 add_finding / update_hypothesis 的語意重疊

2. Evidence 是 Claim 與具體實體之間的關聯，不是獨立的文字欄位
   → 使 evidence 可點擊跳轉、可自動偵測失效

3. Agent Memory 不是獨立結構，而是 Investigation 的一個檢視
   → goal 對應 Investigation.goal
     hypotheses 對應 Claim where status=hypothesis
     discovered 對應 Graph 查詢結果
     todo 對應 Investigation.todo[]
   → 這樣人工模式建立的資料 Agent 自動可見，反之亦然

4. §42 原則 11 應修訂為：
   「人工模式不『必須』填寫 investigation state，
     但所有操作仍自動記錄於同一 model 中」
```

---

### 4.4 T4：§35 有儲存清單但無 schema

**位置**：L1785-1815

**問題**：§35 列出要存的東西：

```text
files / modules / functions / network requests / actions / findings / evidence
```

但完全沒有：實體屬性、主鍵、外鍵、索引、以及 §25 的 graph node/edge 如何映射到關聯式資料表。

**具體缺口**：

1. **Graph 在 SQLite 中如何表示**。§25 定義 11 種 node type、9 種 edge type，且 node 是異質的（Module / DOM Element / API Endpoint / Cookie…）。是要用單一 `nodes` 表加 type 欄位（多型），還是每種 type 一張表？§56 的範例需要多跳查詢（UI Action → … → DOM Change 共 9 跳），SQLite 需用遞迴 CTE，效能與寫法都需要先設計。

2. **Response body 存哪裡**。§35 說存 network requests，但 response body 可能數十 MB。存 BLOB 會讓資料庫迅速膨脹；§27 Session Recording 還要存 screenshots 與 DOM snapshots。單一 session 輕易達 GB 級。需要定義：DB 存 metadata、大型內容存檔案系統（content-addressed）。

3. **多 session 的資料歸屬**。§27 要求「之後可以離線問第 37 秒發生什麼」，代表 session 資料需長期保存。但 artifact 是跨 session 共用的（同一個 main.js）。需定義 session 與 artifact 的多對多關係。

4. **§35 提到「Graph 關係如果很多可以用 Neo4j，但 MVP 不一定需要」** —— 這個判斷需要數量級佐證。以一個中型 SPA 估算：

```text
modules            ~2,000
functions          ~40,000
network flows      ~500 / session
actions            ~100 / session
graph edges        CALLS 邊約 100,000+（函式呼叫關係）
```

SQLite 處理 10 萬級的 edge 表沒有問題，但**遞迴查詢深度 9 層**（§56 的完整鏈）需要實測。建議在規格中標註此為待驗證項目。

**建議**：補上完整 schema。至少定義核心表：

```sql
-- 概念示意，非最終設計
artifact(id PK, sha256, url, mime, first_seen_at)
artifact_version(artifact_id FK, version, storage_path, position_map_path)
module(id PK, artifact_id FK, chunk, module_id, name_override)
function(id PK, module_id FK, ast_path, name_override, start_pos, end_pos)

session(id PK, investigation_id FK, started_at, ended_at)
action(id PK, session_id FK, seq, kind, actor, target, payload_json, at)
flow(id PK, session_id FK, action_id FK NULL, method, url, status,
     req_meta_json, resp_meta_json, req_body_ref, resp_body_ref,
     initiator_json, timing_json)
diff(id PK, session_id FK, action_id FK, kind, before_ref, after_ref)

node(id PK, investigation_id FK, type, ref_kind, ref_id, label)
edge(id PK, src_node FK, dst_node FK, type, confidence, created_by)
claim(id PK, investigation_id FK, status, statement, confidence)
evidence(id PK, claim_id FK, kind, ref_kind, ref_id, position_json)

-- 索引建議
CREATE INDEX idx_flow_action ON flow(action_id);
CREATE INDEX idx_edge_src ON edge(src_node, type);
CREATE INDEX idx_edge_dst ON edge(dst_node, type);
```

---

> **【已解除 2026-08-18：T4】**
>
> 實作於 `packages/core-store/`，使用 Node 內建的 `node:sqlite`
> （零外部依賴、不需編譯 —— 與選 QuickJS 同樣的理由：
> 本專案環境會擋 install scripts）。
>
> **已建立的資料表**
>
> ```text
> tool / tool_approval          工具與信任記錄
> investigation / session       調查與工作階段
> action / flow / binding       觀測記錄
> artifact                      content-addressed 檔案索引
> note                          註記與書籤
> ```
>
> **本節指出的四個缺口，實際採用的處置**
>
> ```text
> 1. Graph 如何表示
>    MVP1 尚未實作 §25 的 Dependency Graph，
>    因此暫不建 node/edge 表。binding 表已能表達
>    action ↔ flow 的關聯，那是目前唯一實際存在的邊。
>
> 2. Response body 存哪裡
>    不進 DB。以 content-addressed 檔案存於 objects/，
>    DB 只保留 hash 參照。相同內容天然去重。
>
> 3. 多 session 的資料歸屬
>    artifact 表獨立於 session，跨 session 共用。
>    action / flow / binding 以 session_id 為複合主鍵的一部分。
>
> 4. 是否需要 Neo4j
>    仍未需要。目前的查詢都是單跳（action → flow），
>    SQLite 的索引已足夠。§56 的九跳查詢要等 Graph 實作後才需重新評估。
> ```
>
> **本節未預見、但實作時發現需要的**
>
> ```text
> 信任綁定到 spec 雜湊而非工具名稱
>   工具內容改變後，先前的核准必須自動失效，
>   否則「核准過的工具」會變成可被竄改的後門。
>
> 綁定記錄產生它的策略與時間窗
>   綁定是策略的產物而非觀測事實。
>   策略日後改變時，可用原始的 action/flow 重新計算。
> ```
>
> **驗收**：`npm run store:check` 共 32 項，全數通過。
> 核心驗證是「關掉再開，工具與觀測記錄仍在，且工具可實際執行」——
> 那正是 `MVP1-PLAN.md` 2.6 指出的、DevTools 結構上缺少的能力。

---

### 4.5 T5：§34 選型未決，且未評估關鍵風險

**位置**：L1748-1783

**問題**：§34 提出三個選項（Python / TypeScript / 混合），但：

1. **沒有給決策依據**。只說「若 Browser automation 為主，TypeScript + Playwright 會很自然；若 AI/Analysis pipeline 為主，Python 也很方便」—— 但這兩件事本專案**都要做**，所以這段話沒有提供任何區分力。

2. **未評估混合架構的最大風險**。§34 建議「Agent Backend 用 Python、Browser Worker 用 Node.js + Playwright」，但沒有提到：

```text
若 backend 選 Python，則 §44.1 建議整合的 webcrack
（TypeScript-only，基於 Babel）只能以 subprocess 或 HTTP 呼叫。

後果：
  - AST 必須跨語言序列化。一個 2 MB 的 minified 檔案，
    其 Babel AST 的 JSON 表示常達 40-80 MB。
  - 每次 find_references / find_callers 若都要傳遞 AST，成本不可接受。
  - 實務上必須讓「所有 AST 操作都留在 Node 側」，
    Python 只拿查詢結果。
  - 但這樣一來 Python 側就只剩 Agent orchestration，
    而 orchestration 用 TypeScript 也完全可行。
```

3. **未考慮 CDP 客戶端的成熟度差異**。Playwright 的 Python binding 在存取 raw CDP session 時，功能與文件都不如 Node 版完整。而本專案 §47 明確要求「架構應避免只依賴 Playwright 高階 API」，大量使用 CDP 是既定方向。

4. **未考慮 GUI 技術棧**。§5 要求完整 GUI（含嵌入式 Chromium 檢視），這在實務上指向 Electron / Tauri + Web 前端。若 backend 是 Python，則需要額外的 IPC 層。

由於使用者選擇「先不決定」，本文不給結論，僅提供決策矩陣（見[第 7 章](#7-技術選型決策矩陣)）。

---

## 5. 邏輯衝突

### 5.1 L1：MVP 定義矛盾【Blocker】

**位置**：§30（L1615-1652）vs §43（L2038-2084）

**問題**：兩章都在定義「第一版」，但範圍差距達兩個開發階段。

| | §30 Phase 1 | §43 最小可行產品 |
|---|---|---|
| 輸入 | 網站 JS directory | 網站 URL 或 JS directory |
| Chromium | ✗ 無 | ✓ 啟動內建 Chromium |
| GUI | ✗ 未提及 | ✓ 人工操作網站、點 Request、跳 JS Module |
| Network 記錄 | ✗ 無 | ✓ Action / Network / DOM / Storage / Console |
| Evidence | ✗ 無 | ✓ 建 Evidence |
| 列出的介面 | 僅 Agent tools | 人工操作為主，LLM 為可選 |

§43 的內容實際上涵蓋了 §30 Phase 1 + §31 MVP2 + §32 MVP3 的一部分。

**更嚴重的問題**：§30 違反 §42 原則 12。

```text
§42 原則 12（L2034）：
  「第一版先做出『人工能追完整功能流程』，再加入 AI 自動化。」

§30 Phase 1（L1636-1645）：
  Agent tools：
    search_code / read_code / get_module / get_function
    find_callers / find_references

  使用者可以問：
    「這個網站登入怎麼運作？」
```

§30 的第一版**只有 Agent tools、沒有 GUI**，使用者互動方式是「用自然語言提問」。這本質上是 **AI-first**，與全文從 §2.0 到 §42 一貫主張的 Human-first 完全相反。

此外，§30 Phase 1 只做靜態分析（無 Chromium），但 §9（L730-760）已論證「現代網站的 API 依賴 cookies / session / CSRF / 動態 signature，不應預設知道 API URL 就能直接 requests.post()」。純靜態分析能回答「登入怎麼運作」的能力其實相當有限 —— 這是文件自己論證過的。

**建議**：以 §43 為準，重寫 §30。建議的 MVP 分期：

```text
MVP 1 — 人工靜態分析工作台（無 Chromium、無 LLM）
  ✓ Resource Collector（給定 URL 抓取 HTML/JS/chunks）
  ✓ Source map 偵測與還原（見 L3）
  ✓ Beautify（帶 position map）
  ✓ AST parse + module/function index
  ✓ Symbol search / find references / callers / callees
  ✓ GUI：Resource Explorer + Code Viewer + 手動 rename + Note
  驗收：使用者能在 GUI 中從一個 endpoint 字串反查到產生它的 function

MVP 2 — 加入 Chromium Runtime
  ✓ Playwright + CDP
  ✓ Network / DOM / Storage / Console 記錄
  ✓ Action Timeline（人工操作即記錄）
  ✓ Network Inspector（借鑑 mitmproxy Flow）
  ✓ Position mapping：request initiator → function
  驗收：使用者點擊一個按鈕後，能在 GUI 中看到觸發的 request，
        並一鍵跳到發出該 request 的 JS function

MVP 3 — Correlation 與 Evidence
  ✓ Action ↔ Network ↔ DOM ↔ Storage 關聯
  ✓ Investigation Graph
  ✓ Evidence System
  ✓ Session Recording / Replay
  ✓ Download / Upload / WebSocket
  驗收：能匯出一份完整的 login flow 報告，每個節點可點擊驗證

MVP 4 — Optional LLM Layer
  ✓ Side Panel（對當前 context 提問）
  ✓ Tool calling
  ✓ Agent Mode
  驗收：關閉 LLM 後 MVP1-3 全部功能不受影響
```

---

### 5.2 L2：`browser_eval` 的風險分級錯置

**位置**：§21（L1150-1221）與 §40（L1934-1971）

**問題**：§21 定義了三個 API 分析 Level，風險序為 `Passive < Browser Context < Standalone`：

```text
Level 1  Passive Observation     只觀察
Level 2  Browser Context Testing 用 browser_eval 呼叫網站自己的 function
Level 3  Standalone Request      自行重建 HTTP request
```

而 §40 的保護機制只涵蓋：

```text
建議在 Agent 中區分：Observe / Replay / Modify
預設優先：Observe
修改 request、重播敏感操作…應加入額外保護機制
例如：DELETE / Purchase / Submit / Transfer / Account modification
```

**衝突**：§21 Level 2 的 `browser_eval` 被歸類為「比 Standalone 安全」，但實際上**它的風險高於 Level 3**：

```text
network_replay(req_12)
  → 風險可界定：重放一個已知的 request
  → 可事前檢查 method、URL、body，判斷是否為敏感操作

browser_eval("search('abc')")
  → 風險不可界定：呼叫的是網站內部函式
  → 該函式可能觸發任意副作用（多個 API 呼叫、狀態變更、
    甚至 __webpack_require__ 存取任意 module）
  → 無法事前靜態判斷影響範圍
  → §21 的範例 search("abc") 看似無害，
    但 Agent 若自行推測函式名稱，可能誤呼叫 deleteAccount()
```

§40 的 method 黑名單（DELETE / Purchase / …）對 `browser_eval` 完全無效，因為它不是透過 HTTP 層執行。

**次要問題**：§40 說「應加入額外保護機制」，但**沒有定義任何具體形式**。是彈出人工確認？method allowlist？dry-run？domain 白名單？全文未答（此為 M7）。

**建議**：

1. 重新定義風險分級，將執行面與網路面分開：

```text
【R0 觀察】無副作用
  network_list, network_get_*, browser_get_dom, browser_snapshot
  ws_get_frames, console_list, 所有 AST 工具

【R1 導航】改變頁面狀態但通常可逆
  browser_open, browser_press, browser_screenshot

【R2 互動】可能觸發網站業務邏輯
  browser_click, browser_fill, mouse_*
  → 預設允許，但記錄於 Action Timeline

【R3 重放】已知內容的重複發送
  network_replay
  → 對 GET/HEAD 預設允許
  → 對 POST/PUT/PATCH/DELETE 需確認

【R4 構造】自行構造或改寫請求
  network_replay_with_changes
  → 一律需確認

【R5 任意執行】影響範圍不可靜態判定
  browser_eval
  → 一律需確認
  → Agent 模式下建議額外要求：先宣告預期影響，再執行
```

2. §21 的 Level 順序建議改為**能力優先序**而非風險優先序，並明確標註：

```text
分析順序：Passive → Browser Context → Standalone（能力遞增）
風險順序：Passive < Replay < Standalone < Browser Context（風險遞增）
兩者不同，不應混淆
```

---

### 5.3 L3：Source Map 優先序放錯

**位置**：§33（L1706-1718）

**問題**：Source Map 被歸類在「§33 後續進階功能」，與 Dynamic Debugger、WASM Analysis、Vision 並列。

**為何應提前**：

```text
若網站公開 source map（.js.map 可存取，或內嵌 sourceMappingURL）：
  → 可直接取得原始檔名、原始變數名、原始程式結構
  → §8 整章的簡化 pipeline（beautify / constant fold /
     decode string array / rename runtime symbols）可完全跳過
  → 分析品質從「猜測 minified 語意」提升到「閱讀原始碼」

實作成本：極低
  - 偵測：檢查 //# sourceMappingURL 註解 + 嘗試 .map 副檔名
  - 解析：source-map 套件為成熟標準方案
  - 這也正好提供了 T1 需要的 position map

命中率：不低
  - 開發環境、內部工具幾乎必然有
  - 正式環境中，Next.js / Vite 等預設行為在部分設定下會保留
  - 部分網站僅移除註解但檔案仍可存取（試 <url>.map）
```

**與 §6 的關聯**：§6 已經定義了 `get_source_map(js_file)` 工具（L581），代表作者已意識到這件事。但 §33 又把它列為進階功能，兩處不一致。

**建議**：

1. 將 Source Map 移至 MVP 1。
2. 修改 §7 的分析流程，加入前置判斷：

```text
取得 JS artifact
    │
    ├─ 有 source map？
    │      ├─ 是 → 還原原始檔案結構
    │      │        跳過 §8 簡化 pipeline
    │      │        position map 直接來自 source map
    │      │        分析品質標記為 high
    │      │
    │      └─ 否 → 進入 §8 簡化 pipeline
    │               需自行產生 position map
    │               分析品質標記為 inferred
    ▼
統一的 module / function index
```

3. 在 Evidence 中記錄品質來源（`high` / `inferred`），使 §39 的 Confidence 有客觀依據之一。

---

## 6. 缺失章節

以下七項在全文中完全沒有對應段落。

### 6.1 M1：驗收標準與成功指標

**現況**：文件有 59 章、2904 行，但**沒有任何一條可驗證的完成定義**。§30/31/32 的 MVP 章節列出的是「功能清單」而非「驗收條件」。

**問題**：以 §30 為例：

```text
自動：
  Beautify
  AST Parse
  Webpack module extraction
  Endpoint extraction
  Symbol Search
```

「Webpack module extraction」在什麼情況下算完成？
- 對 webpack 4 與 5 都支援？
- 對 Next.js 的 App Router chunk 格式支援？
- 抽取成功率要多少？對哪些網站測試？
- 遇到未知打包格式時的行為是什麼？

**建議**：每個 MVP 定義「可執行的驗收情境」。範例：

```text
MVP 1 驗收
  給定：一組固定的 10 個公開網站（含 Next.js / Vite / Vue / 舊式 webpack）
  當：使用者輸入 URL
  則：
    - 至少 8/10 能正確辨識打包器類型
    - 至少 8/10 能抽出 module 邊界，module 數 > 100
    - 對含 source map 的網站，100% 應偵測並使用
    - 單一 5 MB bundle 的完整分析在 60 秒內完成
    - 使用者可在 GUI 搜尋任一字串並跳至定義處，回應 < 500ms

MVP 2 驗收
  給定：一個有登入功能的測試站（自建）
  當：使用者在內建 Chromium 中手動完成登入
  則：
    - Action Timeline 記錄到 click / fill / submit 事件
    - Network Inspector 顯示 POST /api/login
    - 點擊該 request 的「Initiator」可跳至正確的 JS function
      （人工核對，正確率為主要指標）
    - Storage diff 顯示 token 寫入
```

**建議建立固定測試語料庫**：選定一組網站（或自建的 fixture bundle），使所有分析能力的迴歸可量化。

---

### 6.2 M2：測試策略

**現況**：全文零次提及測試。

**最關鍵的缺口是 deobfuscator 的語意等價驗證**。§8 的簡化 pipeline 會改寫程式碼，但沒有任何機制驗證改寫後語意不變。這與 T2 直接相關。

**建議策略**：

```text
【L1 單元測試】各 transform 的 AST 輸入輸出
  對每條 transform 規則建立 fixture pair

【L2 語意等價測試】最重要
  方法 A：差分執行
    在隔離的 V8 isolate 中，對 raw 與 simplified 版本
    以相同輸入執行同一個 export，比對輸出與副作用
  方法 B：property-based
    對 constant_fold 等純運算 transform，
    用隨機輸入驗證等價（含浮點數、BigInt 邊界）

【L3 語料庫迴歸】
  固定的 bundle 語料庫，每次 pipeline 變更後
  比對 module 抽取數量、endpoint 抽取數量的變化
  數量突變即為迴歸訊號

【L4 CDP 事件收集測試】
  自建 fixture 網站，涵蓋：
    XHR / fetch / WebSocket / SSE / download / upload
    redirect / CORS preflight / service worker 攔截
  驗證事件不遺漏、initiator 正確

【L5 端對端】
  Playwright 驅動 GUI 本身，
  跑完 MVP 驗收情境
```

**特別注意**：CDP 事件收集有時序陷阱（`Network.responseReceived` 與 `Network.loadingFinished` 之間 body 尚不可讀、redirect 會產生多個同 requestId 事件），這類問題只有透過 fixture 測試才能穩定捕捉。

---

### 6.3 M3：非功能需求

**現況**：§36（L1819-1834）提到「Network 可能每秒產生大量 request」，§37 提到 context 控制，但**全文沒有任何具體數字**。

**需補齊的量化需求**：

| 項目 | 需定義 | 參考量級 |
|---|---|---|
| Bundle 解析時間上限 | 多大的 JS 在多久內完成 | 5 MB / 60s |
| 單頁 artifact 數量 | 支援上限 | 200+ chunks |
| Network 事件吞吐 | 每秒可記錄的 request 數 | 分析型網站可達 100+/s |
| Response body 保存策略 | 全存 / 依 content-type / 依大小 | > 1 MB 僅存 hash + 前 N KB？ |
| Response body 截斷 | 上限與提示方式 | 見 C3 |
| Session recording 體積 | 單 session 上限與清理策略 | 含 screenshot 可達 GB |
| Screenshot 頻率 | 每個 action / 定時 / 手動 | 影響體積最大的變數 |
| DOM snapshot 策略 | 全量 / 增量 diff | 全量在 SPA 中極耗空間 |
| 並行 session 數 | 同時可開幾個瀏覽器 | 影響記憶體規劃 |
| GUI 回應時間 | 搜尋、跳轉、展開 module | < 500ms |
| 遞迴 graph 查詢 | §56 的 9 跳查詢時間 | 需實測（見 T4） |

**建議**：至少為前五項定下初版數字，其餘標記為待實測。沒有數字的效能需求無法驗收。

---

### 6.4 M4：專案結構與模組邊界

**現況**：文件描述了邏輯架構（§4），但沒有實體結構。

**建議**：定義套件邊界與依賴方向，避免 Core Tools 被 GUI 或 Agent 汙染（這是 §3.1 能否成立的實作保證）。範例：

```text
packages/
  core-model/       資料模型與型別定義，零依賴
  core-store/       SQLite + artifact 檔案儲存
  static-analyzer/  AST / bundle / simplify / position map
  browser-runtime/  Playwright + CDP
  correlator/       cross-layer 關聯建立（本專案差異化核心）
  core-tools/       ★ 統一 Tool API，唯一對外介面
  cli/              → 只依賴 core-tools
  gui/              → 只依賴 core-tools
  agent/            → 只依賴 core-tools（可選套件）

強制規則：
  cli / gui / agent 不得直接 import static-analyzer 或 browser-runtime
  → 用 lint 規則強制，這是 §42 原則 3 的技術保證
  → 若無此約束，GUI 會逐漸繞過 Tool API 直接呼叫底層，
    最終導致 Agent 能做的事比 GUI 少（或相反）
```

---

### 6.5 M5：LLM Provider 抽象

**現況**：§36、§37、§38 描述了 LLM 的使用策略，但沒有任何介面設計。

**未回答的問題**：

```text
□ 支援哪些 provider？（Anthropic / OpenAI / 本地 Ollama / vLLM）
□ API key 如何管理與儲存？（明文設定檔會是安全問題）
□ 成本控制：單次 investigation 的 token 上限？超出時行為？
□ 本地模型可行性：§8 的 rename symbol 任務需要多大的模型？
□ 逾時與重試策略
□ Tool calling 格式差異如何抽象？
□ 送往 LLM 的資料是否可能含敏感內容？
   （response body 可能含 token、個資 —— 需遮蔽策略）
```

**最後一項值得特別注意**：本工具的分析對象包含 cookies、Authorization header、response body 中的個資。若這些內容被原樣送往第三方 LLM API，會構成資料外洩風險。這與 §40 的安全章節有關，但 §40 完全沒提到這個面向。

**建議**：新增 LLM Provider 抽象層設計，並定義**送出前的敏感資料遮蔽規則**（至少對 Authorization / Cookie / Set-Cookie header 預設遮蔽）。

---

> **【已解除 2026-08-18：M5】**
>
> 實作於 `packages/agent-facade/`。
>
> **本節列出的問題，實際處置**
>
> ```text
> 支援哪些 provider    Anthropic + OpenAI 兩種格式。
>                      兩者的 tool calling 結構不同，差異收在抽象層。
>                      本地模型（Ollama / vLLM）多為 OpenAI 相容，
>                      因此走同一條路徑。
>
> API key 管理         一律從環境變數取得，不寫進任何專案檔案。
>                      ARC_LLM_KIND / ARC_LLM_MODEL / ARC_LLM_BASE_URL
>                      OPENAI_API_KEY / ANTHROPIC_API_KEY
>
> Tool calling 差異    OpenAI    tools[].function + message.tool_calls[]
>                      Anthropic tools[].input_schema + content[] 的 tool_use
>
> 逾時                 每次請求可設定，預設 120 秒
>
> 敏感資料遮蔽         見下
> ```
>
> **仍未處理**
>
> ```text
> 成本控制：單次 investigation 的 token 上限
>   目前只有「工具呼叫輪次上限」（預設 8 輪），
>   沒有 token 層級的預算控制。
>
> 本地模型可行性
>   介面已相容，但小模型能否勝任工具選擇尚未實測。
> ```
>
> **遮蔽層（本節指出的「最後一項」）**
>
> 這是整個 LLM 層唯一不可繞過的環節 —— 所有送往 provider
> 的內容都必須先經過 `redact()`。兩條路徑皆然：
>
> ```text
> 內部  GUI 側邊欄     → agent-facade → 遮蔽 → provider
> 外部  Claude Desktop → MCP Server  → 遮蔽 → client
> ```
>
> 規則超出本節的最低建議：
>
> ```text
> 固定欄位  Authorization / Cookie / Set-Cookie / X-Api-Key 等
> 鍵名判斷  token / secret / password / apikey / jwt 等欄位名
> 啟發式    JWT（三段 base64）、Bearer 值、長 base64、
>           email、信用卡號（經 Luhn 驗證以降低誤判）
> ```
>
> **設計取捨**：遮蔽處留下 `[已遮蔽:type#id]` 標記，
> 原值留在宿主端的記錄簿中，使用者可點開查看並自行決定是否附上。
> 誤判的代價因此從「資料遺失」降為「多按一次」。
>
> **驗收**：`npm run agent:check` 共 20 項，含真實模型的
> tool calling 往返，全數通過。

---

### 6.6 M6：License 相容性

**現況**：§44.1（L2148）建議「甚至可以考慮早期直接整合 webcrack，而不是自己從零寫」。但全文未查證任何授權。

**已知授權**（需自行複核最新狀態）：

| 專案 | 授權 | 整合影響 |
|---|---|---|
| webcrack | MIT | 寬鬆，可整合 |
| Playwright | Apache-2.0 | 寬鬆 |
| Babel | MIT | 寬鬆 |
| SWC | Apache-2.0 | 寬鬆 |
| mitmproxy | MIT | 若僅借鑑概念則無影響 |
| OWASP ZAP | Apache-2.0 | 同上 |
| bundle-breaker | 需確認 | 需查 |
| Stagehand / Browser Use / Skyvern | 需確認 | 若僅借鑑架構則無影響 |

**建議**：在規格書中新增一節，明確區分：

```text
【直接整合，程式碼進入產品】
  需逐一確認授權相容性與歸屬聲明義務
  webcrack, Playwright, Babel/SWC 等

【僅借鑑概念與 UX】
  無授權問題，但不應複製其程式碼或資源
  mitmproxy Flow 模型, ZAP 介面配置, Trace Viewer 時間軸

【若本專案未來商業化】
  需重新檢視所有 copyleft 依賴
```

---

### 6.7 M7：§40 缺乏技術強制手段

**位置**：L1934-1971

**現況**：§40 是全文唯一的安全章節，內容為：

```text
此工具應以「自己擁有的網站 / 有明確授權測試的網站 / 開發 QA 除錯…」
為主要使用場景。

建議在 Agent 中區分：Observe / Replay / Modify
預設優先：Observe
…應加入額外保護機制。
```

**問題**：全部都是**原則性宣示**，沒有任何技術機制。「應加入額外保護機制」這句話沒有定義保護機制長什麼樣。

**缺少的機制**：

```text
□ Domain allowlist / blocklist
  → 是否限制可分析的網域？如何設定？

□ 高風險操作的確認流程
  → 彈窗？CLI 提示？設定檔預先授權？
  → Agent 模式下由誰確認？

□ Rate limiting
  → 避免 Agent 迴圈失控對目標站點造成壓力
  → §22 的 replay 若被 Agent 用於參數掃描，
    行為上等同於一次小規模壓測

□ Dry-run 模式
  → 顯示「將要執行什麼」而不實際執行

□ 操作稽核日誌
  → 與 §5.4 Action Timeline 不同，需獨立、不可竄改的紀錄

□ 敏感資料處理（見 M5）
  → Authorization / Cookie 的儲存與顯示遮蔽
  → session recording 中的憑證清理
```

**建議**：將 §40 從「使用倫理宣示」升級為「安全設計規格」，把 L2 提出的 R0-R5 風險分級作為技術基礎，並明確定義每一級的強制手段。

---

> **【後續修訂：M7 的建議已被推翻】**
>
> 上述「在工具層定義強制手段」的建議**方向錯誤**，已由 `MVP1-PLAN.md`
> 第 3 章取代。修正後的立場：
>
> ```text
> 政策不屬於機制層。core-tools 不含任何限制。
>
> 理由來自原規格書自身的邏輯：
>   §3.1 與 §42-3 要求 GUI / CLI / Agent 共用同一套 Core Tools
>   → 把限制寫進 Core Tools，人工操作也會一併被限制
>   → 直接違反 Human-first
>
> 且威脅模型的主體是 LLM（會出錯），不是使用者。
> 既然問題出在 LLM，解法就該在 LLM 那一層。
> ```
>
> **修正後的三層架構**：
>
> | 層 | 內容 |
> |---|---|
> | `core-tools/` | 完整能力、零限制。唯一義務是記錄所有操作到 session |
> | `agent-facade/` | 限制住在這裡。只對 LLM 暴露宣告式介面，LLM 拿不到 `browser_eval` |
> | `gui/` `cli/` | 直接使用 core-tools。速率、dry-run、429 中止皆為**預設值**而非限制，可覆寫 |
>
> **本節列出的「缺少的機制」，修正後的歸屬**：
>
> ```text
> Domain allowlist       → 刪除，不實作
> 高風險操作確認流程       → GUI 預設值（LLM 產生的規格才強制三段式）
> Rate limiting          → GUI 預設值，可覆寫
> Dry-run                → GUI 呈現方式，人工可跳過
> 操作稽核日誌            → 保留，但它是 session 記錄的一部分，
>                          屬於核心功能而非限制
> 敏感資料處理（M5）       → 保留為待決項，屬於 LLM Provider 層
> ```
>
> 另新增**限制的上界原則**（`MVP1-PLAN.md` 3.8）：
> core-tools 不得包含任何政策判定；任何新增限制的提議須同時滿足
> 三項條件，且應優先實作於 agent-facade。此原則用於防止限制
> 隨個案討論不斷增生。
>
> 因此本文件 8.1 修訂 checklist 中的 `M7` 與 `L2` 兩項，
> 應改以 `MVP1-PLAN.md` 3.0-3.8 為準。

---

## 7. 技術選型決策矩陣

由於選型維持未決，本章不給結論，僅提供評估框架與風險分析。

### 7.1 候選方案

```text
方案 A  全 TypeScript
        Node.js 後端 + Playwright + Babel/SWC + Electron/Tauri GUI

方案 B  Python + Node 混合（原文 §34 建議）
        Python 後端（Agent/分析編排）+ Node Browser Worker

方案 C  Rust 核心 + TypeScript 週邊
        SWC(Rust) 做 AST，TS 做 browser 與 GUI
```

### 7.2 評估矩陣

| 評估項 | 權重 | A：全 TS | B：Py+Node | C：Rust+TS |
|---|---|---|---|---|
| webcrack 整合成本 | 高 | ◎ 直接 import | △ 需 subprocess/HTTP | △ 需 binding |
| AST 跨語言序列化 | 高 | ◎ 無此問題 | ✗ 40-80 MB JSON | △ 需設計 |
| Playwright 成熟度 | 高 | ◎ 官方主力 | ○ Python binding 稍弱 | ○ 需經 TS 層 |
| CDP 低階存取 | 高 | ◎ 完整 | △ 文件與範例較少 | ○ |
| GUI 整合 | 中 | ◎ Electron/Tauri 自然 | △ 需額外 IPC 層 | ○ Tauri 原生 |
| 大型 bundle 解析效能 | 中 | ○ Babel 較慢 | ○ 同左 | ◎ SWC 快數倍 |
| LLM SDK 生態 | 中 | ○ 官方 SDK 齊全 | ◎ 生態最豐富 | △ |
| 分析/資料處理生態 | 低 | ○ | ◎ | △ |
| 團隊熟悉度 | ? | 待評估 | 待評估 | 待評估 |
| 單一語言的維護成本 | 中 | ◎ | ✗ 兩套工具鏈 | △ |

圖例：◎優 ○可 △有代價 ✗有實質風險

### 7.3 關鍵風險說明

**方案 B 的 AST 序列化問題（最重要）**

```text
情境：對一個 2 MB 的 minified JS 執行 find_references

若 Python 需要 AST：
  Babel AST 的 JSON 表示約 40-80 MB
  序列化 + 傳輸 + 反序列化，單次操作即數秒
  而 find_references 是高頻操作（GUI 每次點擊都可能觸發）
  → 不可行

因此必然的設計是：
  所有 AST 操作留在 Node 側，Python 只接收查詢結果

但此時 Python 側剩下的職責是：
  - Agent orchestration
  - LLM 呼叫
  - 資料庫存取

這三件事在 TypeScript 中同樣可行。
→ 混合架構的成本（兩套工具鏈、IPC 層、型別重複定義、
   兩份 CI）可能大於其收益。

若仍選 B，建議在規格中明確定義：
  Python 與 Node 的職責邊界
  IPC 協定（建議 JSON-RPC over stdio 或 local HTTP）
  哪些資料結構需要在兩側重複定義，如何保持同步
```

**方案 A 的效能顧慮**

```text
Babel 解析 5 MB minified JS 約需數秒至數十秒。
緩解方式：
  - 改用 SWC（有 Node binding，API 近似 Babel）
  - Worker threads 平行處理多個 chunk
  - 解析結果快取（content-addressed，見 C4）
→ 此風險可控，不構成否決理由
```

**方案 C 的成本**

```text
Rust 的開發速度較慢，且本專案的瓶頸主要在
「設計正確的資料模型與關聯邏輯」，而非執行效能。
MVP 階段引入 Rust 可能是過早最佳化。
→ 建議先不考慮，但可保留「未來將 static-analyzer 抽換為 Rust」
   的可能性 —— 這也是 M4 定義模組邊界的價值之一。
```

### 7.4 建議的決策方式

在規格書中把此項標為**待決**，並定義觸發決策的前置條件：

```text
決策前應先完成：
  1. 一個 spike：用 Babel 解析 3 個真實網站的 bundle，
     測量解析時間與記憶體，驗證 M3 的效能假設
  2. 一個 spike：用 Playwright + CDP 取得 request initiator stack，
     驗證 T1 的技術路徑可行
  3. 確認團隊實際熟悉度

這兩個 spike 本身也是 MVP1/MVP2 的技術驗證，不算額外成本。
```

---

> **【已定案 2026-08-18：方案 A — TypeScript-only】**
>
> **理由**：
>
> ```text
> 1. 避開 7.3 指出的方案 B 主要風險
>    Babel AST 的 JSON 表示達 40-80 MB，
>    而 find_references 是 GUI 高頻操作 → 跨語言序列化不可行
>    推論：AST 操作必然全留在 Node 側，
>          此時 Python 只剩 orchestration，而那用 TS 同樣可行
>
> 2. Playwright / Babel / CDP 同一 runtime，無 IPC 層
> 3. GUI 可用 Electron / Tauri，不需額外橋接
> ```
>
> **S1 實測佐證**（2026-08-18，見 `SPIKES.md` S1 結論）：
>
> ```text
> CDP 低階存取順手         newCDPSession + Network.enable 即可用
> initiator stack 取得率   43 / 44
> stack 平均深度            2.0（fixture 無 vendor 層，
>                              真實網站需再驗證）
> ```
>
> 上述第 2 項 spike（本節建議的前置條件）已由 S1 完成，
> 結果支持 T1 的 position mapping 技術路徑在**資料面**可行。
>
> **仍未驗證**：第 1 項 spike（Babel 解析大型 bundle 的效能），
> 留待 MVP2 執行。此項不影響選型結論，
> 因為方案 A 可在必要時改用 SWC（同為 Node binding）。

---

## 8. 建議修訂順序

### 8.1 修訂 Checklist

**第一階段：機械性修復**（不需設計決策，可直接執行）

```text
□ S1  重畫 §4 兩張架構圖，補上 Agent Controller 框   → 附錄 C 有成品
□ S2  全文章節重編號                                  → 附錄 A 有對照表
□ S2b §1 改為 H1，與其他章節一致
□ S2c 為無編號的 H2 補上編號
□ S3  確認 §28 是否有遺失內容
□ S4  刪除 §57，合併至 §41
□ S4b §58 併入 §55
□ C1  重寫 §29.1 工具清單                             → 附錄 B 有成品
□ C2  統一工具命名慣例                                → 附錄 B 有對照
□ C2b 統一 read_code / read_file 為單一名稱
□ M6  補 License 檢查表
```

**第二階段：需設計決策**（建議依序，後項依賴前項）

```text
□ L1  決定 MVP 範圍，重寫 §30/31/32，與 §43 對齊
□ L3  Source Map 移至 MVP1，修改 §7 分析流程
□ C4  定義 ID 命名空間與 module id 穩定性策略
□ T1  新增「Artifact 版本鏈與 Position Mapping」專章  ← 最重要
□ T1b 修訂 §59，排除無 position map 的 beautifier
□ C3  新增「§29.2 Tool 簽章規範」（依賴 T1 的座標型別）
□ T2  evidence 改以 v0 座標儲存；transform 標註風險等級
□ T3  統一 §5.4/§23/§24/§25 為單一 Investigation State Model
□ T3b 修訂 §42 原則 11 的措辭
□ T4  依 T3 產出 SQLite schema
□ §56 從願景描述改寫為技術規格（依賴 T1 + T3 + T4）
```

**第三階段：補齊缺口**

```text
✗ L2  重新定義風險分級 R0-R5，納入 browser_eval
      → 已推翻。風險分級不進工具層，改為 GUI 預設值與
        agent-facade 的介面設計。見 MVP1-PLAN.md 3.0-3.8
✗ M7  §40 從倫理宣示升級為安全設計規格
      → 已推翻。§40 應改寫為「預設值說明 + 操作記錄保證」，
        而非強制手段。見 6.7 末的修訂註記
□ M5  新增 LLM Provider 抽象層 + 敏感資料遮蔽規則
□ M1  為每個 MVP 定義驗收情境
□ M3  補非功能需求數字
□ M2  補測試策略
□ M4  補專案結構與模組邊界（★ 已有初步方案：MVP1-PLAN.md 3.7）
□ T5  補技術選型決策矩陣，標註待決與前置 spike
```

### 8.2 依賴關係

```text
L1（MVP 範圍）
 └─→ 所有後續章節的範圍界定

T1（Position Mapping）
 ├─→ C3（Tool 簽章需要座標型別）
 ├─→ T2（evidence 座標策略）
 ├─→ §56 改寫
 └─→ T1b（§59 修訂）

C4（ID 命名空間）
 └─→ T1（artifact_id 是 SourcePosition 的一部分）

T3（State Model）
 ├─→ T4（schema）
 └─→ §56 改寫

L2 / M7（風險分級與安全規格）
 └─→ 已移出本文件，改由 MVP1-PLAN.md 3.0-3.8 處理
     且結論與本文件原建議相反（政策不進工具層）
```

**關鍵路徑**：`L1 → C4 → T1 → C3 → T3 → T4 → §56 改寫`

### 8.3 對規格書整體的建議

目前這份文件同時承擔了三種角色，建議拆分：

```text
【VISION.md】保留 §1-3, §41, §42, §56
  產品定位、設計哲學、差異化主張
  → 讀者：所有人。變動頻率低。

【SPEC.md】§4-29 重整後 + 新增的 T1/T3/T4/C3 章節
  資料模型、Tool API、架構、schema
  → 讀者：實作者。這是需要最嚴謹的部分。

【ROADMAP.md】§30-33, §43 整併 + M1 驗收標準
  分期計畫與驗收條件
  → 讀者：專案管理。變動頻率高。

【RESEARCH.md】§44-59
  既有專案調研與技術借鑑
  → 讀者：技術選型時參考。可持續補充。
```

目前 2904 行的單一檔案，實務上很難被完整閱讀與維護；拆分後每份文件的讀者與變動頻率一致，維護成本會顯著下降。

---

# 附錄 A：章節重編號對照表

## A.1 H1 章節

現行 §1 為 H2，其餘為 H1。建議全部統一為 H1。§28 遺失，建議填入新章節。

| 現行 | 建議 | 章節名 | 變更 |
|---|---|---|---|
| `## 1` | `# 1` | 專案概述 | 層級修正 |
| `# 2` | `# 2` | 專案目標 | — |
| `# 3` | `# 3` | 核心設計哲學 | — |
| `# 4` | `# 4` | 整體架構 | 圖表修正（S1） |
| `# 5` | `# 5` | Human Operator UI | — |
| `# 6` | `# 6` | 網站資源收集 | — |
| `# 7` | `# 7` | JavaScript 靜態分析 | 加入 source map 前置判斷（L3） |
| `# 8` | `# 8` | JavaScript 自動簡化 | 加入 transform 風險等級（T2） |
| `# 9` | `# 9` | Chromium Runtime | — |
| `# 10` | `# 10` | Browser Automation | — |
| `# 11` | `# 11` | UI 操作策略 | — |
| `# 12` | `# 12` | Observe → Decide → Act → Verify | — |
| `# 13` | `# 13` | Network 監聽 | — |
| `# 14` | `# 14` | Network Tools | — |
| `# 15` | `# 15` | UI Action 與 Network Event 關聯 | — |
| `# 16` | `# 16` | Upload 分析 | — |
| `# 17` | `# 17` | Download 分析 | — |
| `# 18` | `# 18` | WebSocket | — |
| `# 19` | `# 19` | Storage / Cookie / Session | — |
| `# 20` | `# 20` | Console / Runtime | — |
| `# 21` | `# 21` | API 分析策略 | 加入風險序說明（L2） |
| `# 22` | `# 22` | Request Replay | — |
| `# 23` | `# 23` | Agent Memory | 併入新 §28（T3） |
| `# 24` | `# 24` | Evidence System | 併入新 §28（T3） |
| `# 25` | `# 25` | Dependency / Behavior Graph | 併入新 §28（T3） |
| `# 26` | `# 26` | 使用者查詢範例 | — |
| `# 27` | `# 27` | Session Recording | — |
| — | `# 28` | **Investigation State Model**（新增） | 填補 S3 + 解決 T3 |
| `# 29` | `# 29` | 共用 Tool API | 重寫清單 + 新增簽章規範 |
| `# 30` | `# 30` | MVP 第一版 | 依 L1 重寫 |
| `# 31` | `# 31` | MVP 第二版 | 依 L1 重寫 |
| `# 32` | `# 32` | MVP 第三版 | 依 L1 重寫 |
| `# 33` | `# 33` | 後續進階功能 | 移除 Source Map（L3） |
| `# 34` | `# 34` | 技術選型建議 | 加入決策矩陣（T5） |
| `# 35` | `# 35` | Data Storage | 加入 schema（T4） |
| `# 36` | `# 36` | LLM 呼叫策略 | — |
| `# 37` | `# 37` | Context 控制 | — |
| `# 38` | `# 38` | Agent Loop | — |
| `# 39` | `# 39` | 最終輸出格式 | — |
| `# 40` | `# 40` | 安全與使用邊界 | 改寫為「預設值說明 + 操作記錄保證」，不含強制手段。見 6.7 末修訂註記 |
| `# 41` | `# 41` | 專案定位 | 合併 §57 |
| `# 42` | `# 42` | 最重要的開發原則 | 修訂原則 11（T3b） |
| `# 43` | `# 43` | 最小可行產品定義 | 與 §30-32 對齊 |
| `# 44` – `# 56` | 同 | 類似專案 … 差異化方向 | §56 需改寫 |
| `# 57` | — | 產品定位更新 | **刪除**，併入 §41 |
| `# 58` | — | 建議優先研究順序 | **刪除**，併入 §55 |
| `# 59` | `# 57` | 初期避免重造的輪子 | 修訂 beautifier 建議（T1b） |

新增章節建議插入位置：

```text
# 28  Investigation State Model     ← 統一 §23/24/25/5.4
# 29  共用 Tool API
  29.1  Core Tools 清單
  29.2  Tool 簽章規範                ← 新增（C3）
  29.3  ID 命名空間                  ← 新增（C4）
# 30  Artifact 版本鏈與 Position Mapping   ← 新增（T1），後續章節順延
```

## A.2 H2 編號修正（S2 核心問題）

| 位置 | 現行 | 應為 | 章節名 |
|---|---|---|---|
| L556 | `## 5.1` | `## 6.1` | Resource Collector |
| L589 | `## 6.1` | `## 7.1` | Bundle 辨識 |
| L622 | `## 6.2` | `## 7.2` | AST Parser |
| L653 | `## 7.1` | `## 8.1` | Beautify |
| L663 | `## 7.2` | `## 8.2` | Constant Folding |
| L679 | `## 7.3` | `## 8.3` | Wrapper Simplification |
| L700 | `## 7.4` | `## 8.4` | Known Runtime Rename |
| L714 | `## 7.5` | `## 8.5` | 其他簡化工具 |
| L730 | `## 8.1` | `## 9.1` | 為什麼必須使用真實 Chromium |
| L777 | `## 10.1` | `## 11.1` | 操作優先順序 |
| L794 | `## 10.2` | `## 11.2` | Browser Tool |
| L983 | `## 15.1` | `## 16.1` | File Input |

修正後，`## 5.1` 的重複問題（L346 與 L556）即消除。

## A.3 無編號 H2 補號

| 位置 | 現行 | 建議 |
|---|---|---|
| L1156 | `## Level 1：Passive Observation` | `## 21.1 Level 1：Passive Observation` |
| L1170 | `## Level 2：Browser Context Testing` | `## 21.2 …` |
| L1197 | `## Level 3：Standalone Request` | `## 21.3 …` |
| L1326 | `## Node Types` | `## 25.1 Node Types` |
| L1342 | `## Edge Types` | `## 25.2 Edge Types` |
| L1358 | `## 範例` | `## 25.3 範例` |
| L1383 | `## 登入` | `## 26.1 登入` |
| L1411 | `## 下載` | `## 26.2 下載` |
| L1437 | `## 搜尋 API` | `## 26.3 搜尋 API` |
| L1694 | `## Dynamic Debugger` | `## 33.1 Dynamic Debugger` |
| L1706 | `## Source Map` | 移至 §7（L3） |
| L1722 | `## WASM Analysis` | `## 33.2 WASM Analysis` |
| L1732 | `## Vision` | `## 33.3 Vision` |
| L1750 | `## Backend` | `## 34.1 Backend` |
| L1890 | `## Summary` | `## 39.1 Summary` |
| L1898 | `## Flow` | `## 39.2 Flow` |
| L1914 | `## Evidence` | `## 39.3 Evidence` |
| L1926 | `## Confidence` | `## 39.4 Confidence` |
| L2588 | `## 方案 A` | `## 53.1 方案 A` |
| L2596 | `## 方案 B` | `## 53.2 方案 B` |

## A.4 §29.1 下的分類層級

L1520-1611 的 9 個分類（Files/Code、AST、Simplification、Browser、Network、Storage、Download/Upload、WebSocket、Evidence）目前標為 `##`，與 §29.1 同級。應改為 `###`。

---

# 附錄 B：Core Tools 完整收斂清單

本附錄從全文各章反向收斂出完整工具清單，並提出統一命名。

**命名規則**：`<domain>_<verb>[_<object>]`，動詞用單數。
**狀態欄**：`同` = §29 已列且名稱一致｜`改` = 建議改名｜`補` = §29 遺漏，內文有定義｜`新` = §29 有列但內文未定義，需補定義｜`增` = 本審查建議新增

## B.1 Resource（§6，§29 完全遺漏此分類）

| 建議名稱 | 原名 | 狀態 | 出處 |
|---|---|---|---|
| `resource_list` | `list_resources` | 補/改 | L577 |
| `resource_get_html` | `get_html` | 補/改 | L578 |
| `resource_list_scripts` | `get_script_urls` | 補/改 | L579 |
| `resource_download` | `download_resource` | 補/改 | L580 |
| `resource_get_source_map` | `get_source_map` | 補/改 | L581 |
| `resource_list_chunks` | `list_dynamic_chunks` | 補/改 | L582 |

## B.2 Artifact（本審查建議新增，支撐 T1）

| 建議名稱 | 說明 | 狀態 |
|---|---|---|
| `artifact_get` | 取得指定版本的內容（支援分段） | 增 |
| `artifact_list_versions` | 列出 v0-v3 版本鏈 | 增 |
| `artifact_resolve_position` | **座標跨版本解析，T1 的核心工具** | 增 |
| `artifact_get_pipeline` | 取得該 artifact 套用的 transform 設定 | 增 |

## B.3 Code / Search

| 建議名稱 | 原名 | 狀態 | 備註 |
|---|---|---|---|
| `code_search` | `search_code` | 改 | §29 有列、§30 列為 MVP1 核心，但內文無定義 —— **需補完整規格**（語法、範圍、分頁） |
| `code_read` | `read_file` / `read_code` | 改 | **命名衝突**（L1524 vs L1640），需擇一 |
| `code_list_files` | `list_files` | 改 | 與 `resource_list` 的關係需釐清 |

## B.4 AST（§7.2）

| 建議名稱 | 原名 | 狀態 | 出處 |
|---|---|---|---|
| `ast_parse` | `parse_js_ast` | 改 | L637 |
| `ast_list_functions` | `list_functions` | 改 | L638 |
| `ast_get_function` | `get_function` | 改 | L639 |
| `ast_get_module` | `get_module` | 改 | L640 |
| `ast_get_imports` | `get_imports` | 補/改 | L641 |
| `ast_get_exports` | `get_exports` | 補/改 | L642 |
| `ast_find_definition` | `find_definition` | 改 | L643 |
| `ast_find_references` | `find_references` | 改 | L644 |
| `ast_find_callers` | `find_callers` | 改 | L645 |
| `ast_find_callees` | `find_callees` | 補/改 | L646 |
| `ast_list_modules` | — | 增 | 有 `get_module` 卻無列舉工具 |
| `ast_list_endpoints` | — | 增 | §30 要求 endpoint extraction，但無對應工具 |

## B.5 Simplification（§8.5）

所有工具需補上 T2 的風險等級標註。

| 建議名稱 | 原名 | 狀態 | 風險等級 |
|---|---|---|---|
| `simplify_beautify` | `beautify_js` | 改 | safe |
| `simplify_constant_fold` | `constant_fold` | 改 | likely-safe |
| `simplify_remove_dead_code` | `remove_dead_code` | 改 | **unsafe** |
| `simplify_inline_wrappers` | `inline_simple_wrappers` | 改 | likely-safe |
| `simplify_decode_strings` | `decode_string_array` | 改 | **unsafe** |
| `simplify_normalize_control_flow` | `normalize_control_flow` | 補/改 | **unsafe** |
| `simplify_rename_runtime_symbols` | `rename_known_runtime_symbols` | 補/改 | safe |
| `simplify_normalize_webpack` | `normalize_webpack_modules` | 改 | likely-safe |
| `simplify_apply_source_map` | — | 增 | L3：優先於上述所有 transform |

## B.6 Browser（§11.2）

| 建議名稱 | 原名 | 狀態 | 風險 |
|---|---|---|---|
| `browser_open` | 同 | 同 | R1 |
| `browser_snapshot` | 同 | 同 | R0 |
| `browser_get_dom` | 同 | 同 | R0 |
| `browser_get_accessibility_tree` | 同 | 同 | R0 |
| `browser_click` | 同 | 同 | R2 |
| `browser_click_text` | 同 | 補 (L807) | R2 |
| `browser_fill` | 同 | 同 | R2 |
| `browser_press` | 同 | 同 | R1 |
| `browser_eval` | 同 | 同 | **R5** ← 見 L2 |
| `browser_screenshot` | 同 | 同 | R1 |
| `browser_mouse_move` | `mouse_move` | 補/改 (L817) | R2 |
| `browser_mouse_click` | `mouse_click` | 補/改 (L819) | R2 |
| `browser_mouse_drag` | `mouse_drag` | 補/改 (L821) | R2 |
| `browser_upload_file` | `upload_file` | 新 | R2；§16 只講 Playwright API，未定義此工具 |

## B.7 Network（§14, §22）

| 建議名稱 | 原名 | 狀態 | 風險 |
|---|---|---|---|
| `network_list` | 同 | 同 | R0 |
| `network_get_request` | 同 | 同 | R0 |
| `network_get_response` | 同 | 同 | R0 |
| `network_get_response_body` | 同 | 同 | R0 |
| `network_find_by_url` | 同 | 補 (L906) | R0 |
| `network_find_after_action` | 同 | 同 | R0 |
| `network_wait_for` | 同 | 同 | R0 |
| `network_export_har` | 同 | 同 | R0 |
| `network_replay` | 同 | 補 (L1230) | **R3** |
| `network_replay_with_changes` | 同 | 補 (L1232) | **R4** |
| `network_diff` | — | 增 | §5.5 要求 Compare，但無對應工具 |
| `network_get_initiator` | — | 增 | **T1 的核心**：回傳解析後的 function_ref |

## B.8 Storage（§19）

| 建議名稱 | 原名 | 狀態 |
|---|---|---|
| `storage_get_cookies` | `browser_get_cookies` | 改（統一 domain） |
| `storage_get_local` | `browser_get_local_storage` | 改 |
| `storage_get_session` | `browser_get_session_storage` | 改 |
| `storage_get_indexeddb` | `browser_get_indexeddb` | 改 |
| `storage_diff` | 同 | 補 (L1107) |

## B.9 Console / Runtime（§20，§29 完全遺漏此分類）

| 建議名稱 | 原名 | 狀態 | 出處 |
|---|---|---|---|
| `console_list` | 同 | 補 | L1139 |
| `runtime_get_errors` | 同 | 補 | L1141 |

## B.10 Download / Upload（§17）

| 建議名稱 | 原名 | 狀態 |
|---|---|---|
| `download_list` | `get_downloads` | 改 |
| `download_inspect` | `inspect_download` | 改 |
| `download_read` | `read_download_file` | 改 |

## B.11 WebSocket（§18）

| 建議名稱 | 原名 | 狀態 |
|---|---|---|
| `ws_list` | 同 | 同 |
| `ws_get_frames` | 同 | 同 |
| `ws_find_message` | 同 | 補 (L1068) |

## B.12 Action / Session（§5.4, §27，§29 完全遺漏此分類）

§43 的 MVP 流程明確要求記錄 Action 與 Session，但 §29 沒有任何對應工具。

| 建議名稱 | 說明 | 狀態 |
|---|---|---|
| `action_list` | 列出 timeline | 增 |
| `action_get` | 取得單一 action 的完整前後狀態 | 增 |
| `session_start` / `session_stop` | Session 生命週期 | 增 |
| `session_list` | 列出歷史 session | 增 |
| `session_export` / `session_import` | §27 要求離線分析 | 增 |

## B.13 Investigation / Evidence（§29 現有分類，依 T3 調整）

| 建議名稱 | 原名 | 狀態 | 說明 |
|---|---|---|---|
| `claim_add` | `add_finding` + `update_hypothesis` | 改 | T3：兩者合併為 Claim |
| `claim_update` | `update_hypothesis` | 改 | 用 status 區分 |
| `claim_list` | — | 增 | |
| `evidence_add` | `add_evidence` | 改 | 需帶 SourcePosition |
| `evidence_verify` | — | 增 | 偵測 stale evidence（C4） |
| `graph_add_edge` | `create_dependency` | 改 | |
| `graph_query` | — | 增 | §56 需要多跳查詢 |
| `investigation_get_state` | `get_investigation_state` | 改 | |

## B.14 統計

```text
§29.1 現有：        43 個
內文有定義但 §29 遺漏：21 個
§29 有列但內文無定義：4 個（其中 search_code 為 MVP1 核心）
本審查建議新增：      21 個
────────────────────────────
收斂後總計：約 88 個
```

**§29 現有清單的完整度約為 49%**（43/88）。

---

# 附錄 C：修正後的架構圖

以下為 S1 的修正成品，可直接取代原 §4（L280-338）。原本損毀的第二張圖拆解為三張，並補上原文遺失的 Agent Controller 元件。

## C.1 呼叫者與 Core Tools 的關係

```text
                 ┌──────────────────────────┐
                 │       Core Tools API     │
                 │                          │
                 │  唯一對外介面，三者共用    │
                 └────────────┬─────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
   ┌────────────┐      ┌────────────┐      ┌────────────┐
   │ Desktop UI │      │    CLI     │      │ LLM Agent  │
   │ / Web UI   │      │            │      │ (Optional) │
   └────────────┘      └────────────┘      └──────┬─────┘
                                                  │
                                                  ▼
                                       ┌──────────────────────┐
                                       │ 自然語言 / 自動調查    │
                                       └──────────────────────┘

   ※ 三者能力對等，差別僅在「誰呼叫工具」
   ※ 關閉 LLM Agent 時，左側兩者不受任何影響
```

## C.2 Core Tools 之下的引擎層

```text
                 ┌──────────────────────────┐
                 │       Core Tools API     │
                 └────────────┬─────────────┘
                              │
      ┌───────────────┬───────┴───────┬───────────────┐
      │               │               │               │
      ▼               ▼               ▼               ▼
┌───────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
│  Static   │  │  Chromium  │  │ Correlator │  │Investigation│
│ Analyzer  │  │  Runtime   │  │            │  │   Store     │
│           │  │            │  │            │  │             │
│ AST       │  │ DOM        │  │ Action ↔   │  │ Sessions    │
│ Bundle    │  │ A11y Tree  │  │  Network   │  │ Actions     │
│  Parser   │  │ Network    │  │ Request ↔  │  │ Flows       │
│ Module    │  │ Storage    │  │  Function  │  │ Artifacts   │
│  Graph    │  │ Console    │  │ Position   │  │ Claims      │
│ Symbol    │  │ Downloads  │  │  Mapping   │  │ Evidence    │
│  Search   │  │ Uploads    │  │ Graph      │  │ Graph       │
│ Simplifier│  │ WebSocket  │  │  Builder   │  │ Notes       │
│ SourceMap │  │ Screenshot │  │            │  │             │
└───────────┘  └────────────┘  └────────────┘  └─────────────┘
      │               │               │               │
      └───────────────┴───────┬───────┴───────────────┘
                              ▼
                    ┌──────────────────┐
                    │  Storage Layer   │
                    │ SQLite + Files   │
                    └──────────────────┘

   ※ Correlator 為本專案差異化核心（§56），原文架構圖未呈現此元件
   ※ Evidence Store 更名為 Investigation Store，
     以反映 T3 提出的統一 state model
```

## C.3 Agent Controller（原文遺失的元件）

原文 L315-320 的碎片（「建立調查目標／建立假設／決定下一步工具呼叫／整理 evidence」）應屬於此圖。此元件僅在啟用 LLM 時存在。

```text
                 ┌──────────────────────────┐
                 │    Agent Controller      │
                 │       (Optional)         │
                 │                          │
                 │  - 建立調查目標           │
                 │  - 建立假設               │
                 │  - 決定下一步工具呼叫      │
                 │  - 整理 evidence          │
                 └────────────┬─────────────┘
                              │
                              │ 只能透過 Core Tools API
                              │ 不得直接存取底層引擎
                              ▼
                 ┌──────────────────────────┐
                 │       Core Tools API     │
                 └──────────────────────────┘

   ※ 此元件與 Desktop UI / CLI 位於同一層（見 C.1）
   ※ 移除此元件後，系統其餘部分完全不受影響
     —— 這是 §2.0「AI-optional」的架構保證
```

---

## 文件結束

**本審查未修改 `ai_web_reverse_engineering_agent_project.md`。**

所有建議均為提案性質。附錄 A、B、C 提供了可直接採用的成品，
但是否採納、以及第 7 章的技術選型，仍待決定。
