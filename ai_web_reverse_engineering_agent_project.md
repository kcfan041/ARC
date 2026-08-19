# ARC — Analysis & Runtime Cartography

## 1. 專案概述

### 專案名稱
**ARC — Analysis & Runtime Cartography**

### 名稱說明

**ARC** 代表：

```text
Analysis
&
Runtime
Cartography
```

其中 `Cartography` 指的是「製圖／建立地圖」。

這個名稱對應本專案的核心目標：

```text
UI
↓
DOM
↓
JavaScript
↓
Module
↓
Network
↓
Storage / State
↓
Render
```

將網站在 Runtime 中發生的不同層級事件與依賴關係建立成可觀察、可追蹤、可關聯的結構圖。

ARC 不限定為單純的 Network 工具、JavaScript Deobfuscator 或 AI Agent，而是涵蓋整體 Web Runtime Investigation。

### 核心概念
建立一套**可由人為直接操作**的網站分析與逆向工程平台，並把大型語言模型（LLM）與 Agent 視為其中一個可選功能。

工具本體必須在完全不使用 LLM 的情況下，也能完成：

- 網站資源收集
- JavaScript / AST 分析
- Bundle / Chunk / Module 瀏覽
- Chromium 操作
- DOM / Accessibility 檢視
- Network / WebSocket 監聽
- Upload / Download 分析
- Cookie / Storage / Console 檢視
- Request / Response 比較
- Session Recording
- Evidence / Dependency Graph 建立

LLM 則作為附加的「分析、自動化與自然語言介面」功能，協助使用者快速理解、搜尋、追蹤與執行重複操作。

因此系統不是單純的 AI Agent，而是一套：

```text
人工操作工具
+
自動分析工具
+
可選 LLM / Agent
```

平台可搭配：

- JavaScript 靜態分析
- AST（Abstract Syntax Tree）解析
- Webpack / Next.js / Vite 等 bundle 結構辨識
- Chromium 瀏覽器自動化
- Chrome DevTools Protocol（CDP）
- DOM / Accessibility Tree
- Network Request / Response 監聽
- Upload / Download 監聽
- WebSocket 監聽
- Storage / Cookie / Console 觀察
- Screenshot + Vision 作為 UI fallback
- Evidence / Dependency Graph

使用者可以完全手動操作所有功能，也可以選擇讓 LLM 協助。

啟用 LLM 後，可直接詢問：

> 「這個網站是怎麼運作的？」

或更具體地詢問：

> 「登入流程怎麼走？」  
> 「按下下載按鈕後發生什麼？」  
> 「這個 API 的 body 是怎麼產生的？」  
> 「這個 token 存在哪裡？」  
> 「這個 UI 操作觸發了哪些 API？」  
> 「某個 request 的 signature 是在哪個 JS function 產生的？」

Agent 可以自行搜尋、追蹤、操作瀏覽器、觀察結果並建立可驗證的結論。

---

# 2. 專案目標

## 2.0 核心產品原則

### Human-first

工具的主要能力必須可以由人直接操作。

例如使用者可以自行：

```text
打開 Chromium
↓
選擇 DOM Element
↓
查看 event listener
↓
查看 action 前後 Network
↓
打開某個 request
↓
查看 body / response
↓
跳到相關 JS function
↓
追 callers / callees
↓
建立 bookmark / evidence
```

不需要 LLM 才能完成這些操作。

### AI-optional

LLM / Agent 是：

```text
Assistant
Automation
Natural Language Interface
```

而不是系統必要依賴。

關閉 LLM 時：

```text
Static Analyzer
Browser Inspector
Network Inspector
Debugger
Session Recorder
Evidence Graph
```

仍然必須正常工作。

### Shared Tooling

人工操作和 Agent 必須共用同一套底層 Tool API。

例如：

```text
Human UI
   │
   ├── get_module(4278)
   ├── network_get_request(req_12)
   └── browser_click(button)

LLM Agent
   │
   ├── get_module(4278)
   ├── network_get_request(req_12)
   └── browser_click(button)
```

兩者只是「誰在呼叫工具」不同。



## 2.1 主要目標

建立一個能讓人與 AI 共同理解現代網站前端運作方式的分析平台，包括：

1. 讀取網站 HTML / JS / Source Map / WASM 等資源
2. 自動辨識前端框架與打包方式
3. 分析 bundle、chunk、module 與 function 依賴
4. 對 minified / partially obfuscated JavaScript 進行簡化
5. 找出 API、WebSocket、Storage、Cookie 等資料流
6. 控制真實 Chromium 執行網站
7. 監聽所有重要 Browser / Network 行為
8. 將 UI 操作與 Network / JS / State 變化建立關聯
9. 讓 LLM 自主決定下一步需要調查什麼
10. 每個結論盡可能附上 evidence

---

# 3. 核心設計哲學

## 3.1 工具優先，而不是 Agent 優先

核心架構應該是：

```text
                 Core Tools
                     │
       ┌─────────────┴─────────────┐
       │                           │
       ▼                           ▼
   Human UI                    LLM Agent
```

而不是：

```text
LLM Agent
   │
   └── 所有能力
```

所有重要功能都應先以：

```text
API / Tool
```

方式實作。

之後：

- Desktop / Web UI 可以呼叫
- CLI 可以呼叫
- LLM Agent 也可以呼叫

這樣系統即使沒有 AI，也仍然是一套完整工具。

## 3.2 LLM 不應該負責所有事情

LLM 適合：

- 理解程式語意
- 建立假設
- 決定下一步分析方向
- 推論不同事件之間的關係
- 為 minified symbol 重新命名
- 解釋整體網站流程
- 整理調查結果

LLM 不適合直接負責：

- 全文 grep
- 幾 MB / 幾十 MB JavaScript 全部逐字閱讀
- 精確 AST parsing
- 大量 symbol reference 計算
- dependency graph extraction
- constant folding
- 大規模字串 decode
- HTTP / Network event 原始紀錄整理

因此設計原則為：

```text
LLM
= 大腦 / 分析決策

Parser / AST / Browser / CDP / Network
= 眼睛 / 手 / 儀器
```

---

# 4. 整體架構

```text
                 ┌──────────────────────┐
                 │        Core Engine    │
                 │                      │
                 │ Browser / AST / CDP  │
                 │ Network / Storage    │
                 │ Session / Evidence   │
                 └──────────┬───────────┘
                            │
            ┌───────────────┼────────────────┐
            │               │                │
            ▼               ▼                ▼
     ┌────────────┐   ┌────────────┐   ┌────────────┐
     │ Desktop UI │   │    CLI     │   │  LLM Agent │
     │ / Web UI   │   │            │   │  Optional  │
     └────────────┘   └────────────┘   └──────┬─────┘
                                              │
                                              ▼
                                   ┌──────────────────────┐
                                   │ 自然語言 / 自動調查   │
                                   └──────────────────────┘
```

底層分析模組：

```text
                   ┌──────────────────────┐
                   │    Tool / Core API   │
                   └──────────┬───────────┘
                              │
          ┌───────────────────┼────────────────────┐
          │                   │                    │
          ▼                   ▼                    ▼
┌─────────────────┐ ┌──────────────────┐ ┌─────────────────┐
│ Static Analyzer │ │ Chromium Runtime │ │ Evidence Store  │
                   │                      │
                   │ - 建立調查目標        │
                   │ - 建立假設            │
                   │ - 決定下一步工具呼叫   │
                   │ - 整理 evidence       │
                   └──────────┬───────────┘
                              │
          ┌───────────────────┼────────────────────┐
          │                   │                    │
          ▼                   ▼                    ▼
┌─────────────────┐ ┌──────────────────┐ ┌─────────────────┐
│ Static Analyzer │ │ Chromium Runtime │ │ Evidence Store  │
│                 │ │                  │ │                 │
│ AST             │ │ DOM              │ │ Findings        │
│ Bundle Parser   │ │ Accessibility    │ │ Hypotheses      │
│ Module Graph    │ │ Network          │ │ Dependencies    │
│ Symbol Search   │ │ Storage          │ │ Action History  │
│ Simplifier      │ │ Console          │ │ Confidence      │
└─────────────────┘ │ Downloads        │ └─────────────────┘
                    │ Uploads          │
                    │ WebSocket        │
                    │ Screenshot       │
                    └──────────────────┘
```

---

# 5. Human Operator UI

工具本體應提供完整 GUI，讓使用者可以不靠 LLM 直接操作。

## 5.1 建議主畫面

```text
┌────────────────────────────────────────────────────────────┐
│ URL / Session / Project                                   │
├──────────────┬───────────────────────────┬─────────────────┤
│ Resource     │ Browser                   │ Inspector       │
│ Explorer     │                           │                 │
│              │ Chromium View             │ DOM             │
│ JS           │                           │ Network         │
│ Chunks       │                           │ Storage         │
│ Modules      │                           │ Console         │
│ Functions    │                           │ WebSocket       │
│ API          │                           │ Evidence        │
├──────────────┴───────────────────────────┴─────────────────┤
│ Timeline / Actions / Network / Events                      │
└────────────────────────────────────────────────────────────┘
```

---

## 5.2 Resource Explorer

使用者可以人工瀏覽：

```text
HTML
JS
CSS
Source Map
WASM
Chunks
Webpack Modules
Functions
Endpoints
```

支援：

```text
搜尋
跳到 definition
Find references
Find callers
Find callees
Bookmark
Add evidence
```

---

## 5.3 Network Inspector

介面類似 DevTools Network：

```text
Method
URL
Status
Type
Initiator
Action ID
Duration
Size
```

點選 request 後可查看：

```text
Headers
Cookies
Query
Request Body
Response
Timing
Initiator
相關 JS
相關 UI Action
```

---

## 5.4 Action Timeline

將人工操作也記錄成 action：

```text
action_12
Human Click
"搜尋"

action_13
Human Input
"台積電"

action_14
Human Click
"送出"
```

這樣即使沒有 Agent，也能做到：

```text
UI Action
↔
Network
↔
DOM Change
↔
Storage Change
```

的關聯分析。

---

## 5.5 Manual Replay / Modify

使用者可以手動選擇 request：

```text
Open
Replay
Clone
Modify
Compare
```

例如：

```text
Request A
page = 1

Request B
page = 2
```

由系統產生 diff。

---

## 5.6 Manual JS Investigation

使用者選到：

```text
module 4278
```

可以：

```text
Open Module
Beautify
Show AST
Show Imports
Show Exports
Show Callers
Show Callees
Rename Symbol
Add Note
Ask LLM（可選）
```

其中：

```text
Ask LLM
```

只是附加功能。

---

## 5.7 LLM Side Panel

LLM 可以做成可開關側邊欄：

```text
┌──────────────────────┐
│ AI Assistant         │
│                      │
│ 解釋目前 request      │
│ 追蹤此 function       │
│ 整理這段流程          │
│ 自動分析此功能        │
└──────────────────────┘
```

它取得的是目前人工操作的 context。

例如使用者正在看：

```text
req_52
```

可以直接點：

```text
Explain with AI
```

而不是 Agent 接管整個工具。

---

# 6. 網站資源收集

## 5.1 Resource Collector

系統首先收集網站可能需要分析的資源。

### 可能包含

- HTML
- JavaScript
- CSS
- JSON
- Source Map
- WebAssembly
- Dynamic chunks
- Worker scripts
- Service Worker
- API response sample
- WebSocket message sample

### 建議工具

```text
list_resources()
get_html()
get_script_urls()
download_resource(url)
get_source_map(js_file)
list_dynamic_chunks()
```

---

# 7. JavaScript 靜態分析

## 6.1 Bundle 辨識

自動判斷可能使用：

- Webpack
- Next.js
- Vite
- Rollup
- Parcel
- Nuxt
- React
- Vue
- Angular
- Svelte
- 其他打包器

### 目標

辨識：

```text
runtime
vendor chunk
entry module
page chunk
dynamic chunk
module id
imports
exports
```

---

## 6.2 AST Parser

使用 AST parser 分析 JavaScript，而非完全依賴 LLM。

可考慮：

- Babel parser
- SWC
- Acorn
- Esprima
- Tree-sitter

### 工具介面

```text
parse_js_ast(file)
list_functions(file)
get_function(function_id)
get_module(module_id)
get_imports(module)
get_exports(module)
find_definition(symbol)
find_references(symbol)
find_callers(function)
find_callees(function)
```

---

# 8. JavaScript 自動簡化

## 7.1 Beautify

先將 minified JavaScript 格式化。

```text
beautify_js(file)
```

---

## 7.2 Constant Folding

例如：

```js
const x = 1 + 2;
```

轉換：

```js
const x = 3;
```

---

## 7.3 Wrapper Simplification

例如：

```js
var n = function(n) {
    return e(e.s = n)
}
```

簡化成：

```js
function loadEntry(moduleId) {
    e.s = moduleId;
    return e(moduleId);
}
```

---

## 7.4 Known Runtime Rename

例如 Webpack runtime：

```text
e -> __webpack_require__
e.s -> entryModule
e.O -> deferredChunkExecutor
```

名稱不一定是原始名稱，但可以提高可讀性。

---

## 7.5 其他簡化工具

```text
constant_fold()
remove_dead_code()
inline_simple_wrappers()
decode_string_array()
normalize_control_flow()
rename_known_runtime_symbols()
normalize_webpack_modules()
```

---

# 9. Chromium Runtime

## 8.1 為什麼必須使用真實 Chromium

現代網站 API 常依賴：

- Cookies
- Session
- CSRF Token
- JWT
- LocalStorage
- IndexedDB
- 動態 signature
- nonce
- timestamp
- JavaScript runtime state
- Browser fingerprint
- Cloudflare / Akamai 等 browser challenge

因此，不應預設：

```text
知道 API URL
=
可以直接 requests.post()
```

比較合理的是：

```text
Agent 控制真正的 Chromium
```

---

# 10. Browser Automation

建議底層使用：

- Playwright
- Puppeteer
- Chrome DevTools Protocol

其中 Playwright 可以作為主要 Browser Controller，CDP 用於較底層觀察。

---

# 11. UI 操作策略

## 10.1 操作優先順序

不要一開始就使用滑鼠座標。

建議優先級：

```text
1. DOM
2. Accessibility Tree
3. Playwright Locator
4. JavaScript execution
5. Screenshot + Vision
6. Mouse coordinates
```

---

## 10.2 Browser Tool

```text
browser_open(url)

browser_snapshot()

browser_get_dom()

browser_get_accessibility_tree()

browser_click(selector)

browser_click_text(text)

browser_fill(selector, value)

browser_press(key)

browser_eval(js)

browser_screenshot()

mouse_move(x, y)

mouse_click(x, y)

mouse_drag(x1, y1, x2, y2)
```

---

# 12. Observe → Decide → Act → Verify

Agent 不應一次規劃大量 UI 操作。

應使用：

```text
Observe
↓
Decide
↓
Act
↓
Verify
```

例如：

```text
Observe:
發現 button「登入」

Decide:
點擊登入

Act:
click(button)

Verify:
是否出現 /api/login request？
是否 URL 改變？
是否 DOM 出現登入成功狀態？
```

若沒有出現預期結果：

```text
重新觀察
↓
修正假設
```

---

# 13. Network 監聽

這會是整個系統最重要的能力之一。

透過 CDP / Playwright 監聽：

- HTTP Request
- HTTP Response
- Request Headers
- Request Body
- Response Headers
- Response Body
- Redirect
- Fetch
- XHR
- WebSocket
- SSE
- Download
- Upload
- Timing

---

# 14. Network Tools

```text
network_list()

network_get_request(id)

network_get_response(id)

network_get_response_body(id)

network_wait_for(pattern)

network_find_by_url(pattern)

network_find_after_action(action_id)

network_export_har()
```

---

# 15. UI Action 與 Network Event 關聯

單純 HAR 只能得到：

```text
GET A
POST B
POST C
```

但 Agent 更需要知道：

```text
哪個操作造成哪個 request
```

因此每次 Agent 操作都產生：

```text
action_id
```

例如：

```text
action_41

Action:
click "搜尋"

State before:
query = 台積電

Network:
req_812
req_813

DOM diff:
diff_192

Storage diff:
none
```

如此可建立：

```text
click 搜尋
    │
    ├── POST /api/search
    │
    └── POST /analytics/event
```

LLM 可以進一步推論：

```text
/api/search
= 功能 API

/analytics/event
= telemetry
```

---

# 16. Upload 分析

## 15.1 File Input

若網站存在：

```html
<input type="file">
```

不必真的操作 OS 檔案選擇器。

可以直接：

```js
await locator.setInputFiles(filePath);
```

Agent 可以觀察：

```text
選擇 test.png
↓
POST /api/upload
↓
multipart/form-data
↓
response fileId
↓
fileId 被另一個 API 使用
```

---

# 17. Download 分析

Agent 應可以監聽：

```text
Download started
Download completed
Filename
MIME type
Trigger action
Associated request
```

工具：

```text
get_downloads()

inspect_download(id)

read_download_file(id)
```

下載檔案可進一步交給：

- JSON parser
- CSV parser
- Excel parser
- PDF parser
- ZIP parser

---

# 18. WebSocket

現代網站可能大量依賴 WebSocket。

建議監聽：

```text
WebSocket created
Frame sent
Frame received
Connection closed
```

工具：

```text
ws_list()

ws_get_frames(connection_id)

ws_find_message(pattern)
```

可建立：

```text
UI Action
↓
WebSocket Send
↓
Server Message
↓
State Update
↓
DOM Update
```

---

# 19. Storage / Cookie / Session

Agent 可觀察：

- Cookies
- LocalStorage
- SessionStorage
- IndexedDB

工具：

```text
browser_get_cookies()

browser_get_local_storage()

browser_get_session_storage()

browser_get_indexeddb()

storage_diff(before, after)
```

例如追蹤：

```text
POST /api/login
↓
response.accessToken
↓
localStorage["access_token"]
↓
subsequent request Authorization header
```

---

# 20. Console / Runtime

Agent 可監聽：

```text
console.log
console.warn
console.error
Unhandled exceptions
Promise rejection
```

工具：

```text
console_list()

runtime_get_errors()

browser_eval(js)
```

這對追蹤動態行為很有價值。

---

# 21. API 分析策略

Agent 不應一開始就直接自己重建 API request。

建議分三個 Level。

## Level 1：Passive Observation

只觀察網站真正操作產生的 request。

```text
UI
↓
網站自己呼叫 API
↓
Agent 監聽
```

---

## Level 2：Browser Context Testing

在網站自己的 browser runtime 裡呼叫原有 function。

例如網站有：

```js
search("abc")
```

Agent 可以：

```text
browser_eval(...)
```

讓網站自己處理：

- timestamp
- nonce
- signature
- CSRF
- cookies
- session

---

## Level 3：Standalone Request

最後才嘗試：

```text
獨立 HTTP Client
```

自行重建：

- headers
- body
- cookies
- auth
- signature

優先順序：

```text
Passive
↓
Browser Context
↓
Standalone
```

---

# 22. Request Replay

可以提供：

```text
network_replay(request_id)

network_replay_with_changes(
    request_id,
    changes
)
```

但應預設受控使用。

例如：

```text
原始 request

query = apple
page = 1

↓

只修改

page = 2

↓

比較 response
```

這是一種 controlled experiment。

---

# 23. Agent Memory

Agent 需要有結構化工作記憶。

例如：

```json
{
  "goal": "Understand login flow",
  "hypotheses": [
    {
      "statement": "module 4278 initializes auth",
      "confidence": 0.72
    }
  ],
  "discovered": {
    "endpoints": [
      "/api/login",
      "/api/session"
    ],
    "storage": [
      "access_token"
    ]
  },
  "todo": [
    "Trace access_token writes",
    "Find refresh-token logic"
  ]
}
```

---

# 24. Evidence System

避免 LLM 看錯一段 minified code 後開始腦補。

每個重要結論應儘量附 evidence。

例如：

```text
Conclusion:
access token 被存入 localStorage

Evidence:
main.js
module 1827
function saveSession()
line / AST node

Runtime Evidence:
action_17
response req_52
storage diff_9
```

---

# 25. Dependency / Behavior Graph

可以建立一個網站運作圖。

## Node Types

```text
Module
Function
Variable
DOM Element
UI Action
API Endpoint
WebSocket
Storage Key
Cookie
Downloaded File
Uploaded File
```

## Edge Types

```text
IMPORTS
CALLS
READS
WRITES
TRIGGERS
SENDS_TO
RECEIVES_FROM
UPDATES
DEPENDS_ON
```

---

## 範例

```text
LoginButton
    │ TRIGGERS
    ▼
handleLogin
    │ CALLS
    ▼
authService.login
    │ SENDS_TO
    ▼
POST /api/login
    │ RECEIVES
    ▼
accessToken
    │ WRITES
    ▼
localStorage["access_token"]
```

---

# 26. 使用者查詢範例

## 登入

```text
這個網站登入是怎麼運作的？
```

Agent：

```text
搜尋 Login Button
↓
找 handler
↓
追 function
↓
監聽實際 login request
↓
追 body
↓
追 response token
↓
追 storage
↓
輸出 login flow
```

---

## 下載

```text
按下載報表後網站做了什麼？
```

Agent：

```text
click Download
↓
action_id = 42
↓
觀察 Network
↓
GET /api/report/export
↓
監聽 download
↓
取得 report.xlsx
↓
建立完整流程
```

---

## 搜尋 API

```text
搜尋功能是怎麼工作的？
```

Agent：

```text
click Search
↓
POST /api/search
↓
取得 request body
↓
追 request builder function
↓
找到 signature
↓
找到 response renderer
```

---

# 27. Session Recording

建議可以完整記錄一次 Browser Session。

包含：

```text
Actions
DOM snapshots
Screenshots
Network HAR
Console
Cookies
Storage snapshots
Downloads
Uploads
WebSocket events
```

形成：

```text
Web Session Recording
```

之後可以離線問：

```text
第 37 秒點擊建立訂單時發生什麼？
```

而不需要重新操作網站。

---

# 29. 共用 Tool API

所有底層功能應先定義成共用 Tool API。

這些 API 同時提供給：

```text
GUI
CLI
Script
Plugin
LLM Agent
```

因此比較適合稱為：

```text
Core Tools
```

而不是 Agent 專屬工具。

## 29.1 Core Tools

## Files / Code

```text
list_files
read_file
search_code
```

## AST

```text
parse_js_ast
list_functions
get_function
get_module
find_definition
find_references
find_callers
find_callees
```

## Simplification

```text
beautify_js
constant_fold
remove_dead_code
decode_string_array
inline_simple_wrappers
normalize_webpack_modules
```

## Browser

```text
browser_open
browser_snapshot
browser_get_dom
browser_get_accessibility_tree
browser_click
browser_fill
browser_press
browser_eval
browser_screenshot
```

## Network

```text
network_list
network_get_request
network_get_response
network_get_response_body
network_find_after_action
network_wait_for
network_export_har
```

## Storage

```text
browser_get_cookies
browser_get_local_storage
browser_get_session_storage
browser_get_indexeddb
```

## Download / Upload

```text
get_downloads
inspect_download
read_download_file
upload_file
```

## WebSocket

```text
ws_list
ws_get_frames
```

## Evidence

```text
add_finding
add_evidence
update_hypothesis
create_dependency
get_investigation_state
```

---

# 30. MVP 第一版

不建議第一版直接做到全自動網站逆向。

## Phase 1

支援：

```text
輸入：
網站 JS directory
```

自動：

- Beautify
- AST Parse
- Webpack module extraction
- Endpoint extraction
- Symbol Search

Agent tools：

```text
search_code
read_code
get_module
get_function
find_callers
find_references
```

使用者可以問：

```text
這個網站登入怎麼運作？
```

---

# 31. MVP 第二版

加入 Chromium：

- Playwright
- CDP
- Network listener
- DOM
- Accessibility
- Screenshot
- Cookies
- LocalStorage

Agent 可以：

```text
自己打開網站
自己點 UI
觀察 request
把 runtime evidence 和 JS static analysis 合併
```

---

# 32. MVP 第三版

加入：

- Download / Upload
- WebSocket
- HAR recording
- Session recording
- Action → Network correlation
- Evidence graph

---

# 33. 後續進階功能

## Dynamic Debugger

加入：

- Breakpoint
- Function breakpoint
- XHR breakpoint
- Runtime variable inspection
- Call stack

---

## Source Map

若網站公開 Source Map：

```text
minified.js
↓
source map
↓
原始 module / filename
```

可以大幅提升分析品質。

---

## WASM Analysis

加入：

- wasm parser
- imports / exports
- JS ↔ WASM call tracing

---

## Vision

只有 DOM / Accessibility 無法操作時，才使用：

```text
Screenshot
↓
Vision Model
↓
Locate target
↓
Mouse coordinate
```

---

# 34. 技術選型建議

## Backend

可選：

- Python
- TypeScript / Node.js

若 Browser automation 為主：

```text
TypeScript + Playwright
```

會很自然。

若 AI / Analysis pipeline 為主：

```text
Python
```

也很方便。

實際上可以：

```text
Agent Backend
Python

Browser Worker
Node.js + Playwright
```

---

# 35. Data Storage

早期可以用：

```text
SQLite
```

儲存：

- files
- modules
- functions
- network requests
- actions
- findings
- evidence

後續可考慮：

```text
PostgreSQL
```

Graph 關係如果很多，也可以：

```text
Neo4j
```

但 MVP 不一定需要 graph database。

---

# 36. LLM 呼叫策略

不要每個 event 都呼叫 LLM。

例如 Network 可能每秒產生大量 request。

先由傳統程式做：

```text
filter
deduplicate
classify
summarize
```

之後才送重要資料給 LLM。

---

# 37. Context 控制

不要把整個網站一次放入 prompt。

使用：

```text
Retrieval
+
Tool Calling
+
Agent Memory
```

LLM 只取得：

```text
目前任務所需要的程式碼
```

---

# 38. Agent Loop

```text
User Goal
↓
Create Investigation
↓
Observe
↓
Generate Hypothesis
↓
Select Tool
↓
Collect Evidence
↓
Update Graph
↓
Verify Hypothesis
↓
Need More Evidence?
    ├─ Yes → Continue
    └─ No  → Report
```

---

# 39. 最終輸出格式

Agent 最後可以輸出：

## Summary

```text
網站登入使用 POST /api/login。
登入成功後 access token 被存入 localStorage。
之後所有 API request 透過 Authorization: Bearer ...
```

## Flow

```text
LoginButton
↓
handleLogin
↓
auth.login
↓
POST /api/login
↓
accessToken
↓
localStorage
```

## Evidence

```text
Static:
main.js / module 1827

Runtime:
action_17
request_52
storage_diff_9
```

## Confidence

```text
High
```

---

# 40. 安全與使用邊界

此工具應以：

- 自己擁有的網站
- 有明確授權測試的網站
- 開發 / QA / 除錯
- API / 前端研究
- 相容性測試
- 安全研究授權環境

為主要使用場景。

建議在 Agent 中區分：

```text
Observe
Replay
Modify
```

預設優先：

```text
Observe
```

修改 request、重播敏感操作或執行可能造成資料變更的行為時，應加入額外保護機制。

例如：

- DELETE
- Purchase
- Submit
- Transfer
- Account modification

應避免讓 Agent 未經確認直接執行。

---

# 41. 專案定位

這個專案最終比較適合被理解成：

> **ARC — Analysis & Runtime Cartography**

並額外提供：

> **AI Web Analysis Assistant / Agent Mode**

核心產品是：

```text
Static Analysis
+
Chromium
+
CDP
+
Network Inspector
+
Runtime Instrumentation
+
Evidence Graph
+
Human UI
```

LLM 則是：

```text
Optional AI Layer
```

使用者可以：

```text
完全手動
半自動
Agent 全自動
```

三種模式自由切換。

---

# 42. 最重要的開發原則

1. **所有核心能力必須可由人直接操作。**
2. LLM / Agent 必須是可選功能，而不是必要依賴。
3. GUI、CLI、Agent 共用同一套 Core Tool API。
4. 不要讓 LLM 吃完整 bundle。
5. AST / Search / Dependency 應交給傳統程式。
6. 真實 Chromium 應是主要 runtime。
7. API 分析優先觀察，不優先偽造。
8. UI 操作優先 DOM / Accessibility，不優先滑鼠。
9. 每個 Action、Network、DOM、Storage 事件都應可人工檢視。
10. 每個重要結論儘量保留 evidence。
11. Agent 必須維護 investigation state，但人工模式不依賴它。
12. 第一版先做出「人工能追完整功能流程」，再加入 AI 自動化。

---

# 43. 最小可行產品定義

第一個真正有價值的版本應先是一套完整人工分析工具：

```text
1. 使用者輸入網站 URL 或 JS directory

2. 工具收集：
   HTML
   JS
   Chunk

3. 建立：
   module index
   function index
   endpoint index

4. 啟動內建 Chromium

5. 使用者人工操作網站

6. 工具同步記錄：
   Action
   Network
   DOM
   Storage
   Console

7. 使用者可人工：
   點 Request
   看 Initiator
   跳 JS Module
   查 Function
   看 Caller / Callee
   建 Evidence

8. 可選：
   對目前內容呼叫 LLM：
   「解釋這個 request」
   「幫我追這個 function」
   「整理剛才的操作流程」

9. 後續才加入：
   Agent 自主操作與自動 Investigation
```

只要人工模式可以穩定追出完整網站功能流程，這個工具本身就已經有價值；AI 是在此基礎上增加效率，而不是填補基本能力。


---

# 44. 類似專案與可借鑑方向

目前已經有不少專案各自處理了本平台中的某一部分能力，但尚未看到一個成熟工具完整整合：

```text
Human-operated Web Reverse Engineering
+
Chromium Runtime
+
JavaScript / AST Static Analysis
+
Network / Storage / Action Correlation
+
Optional LLM Agent
```

因此比較合理的策略不是從零重做全部底層能力，而是研究並借鑑現有專案的架構、資料模型與操作介面。

---

## 44.1 webcrack

專案：

```text
https://github.com/j4k0xb/webcrack
```

定位：

```text
JavaScript reverse engineering
Deobfuscation
Unminification
Bundle unpacking
```

適合借鑑的部分：

- JavaScript beautify
- deobfuscation pipeline
- Webpack / Browserify unpack
- AST transformation
- identifier / expression simplification
- 將打包後程式拆回較容易閱讀的 module

可對應到本專案：

```text
Static Analysis Engine
├── beautify_js
├── normalize_webpack_modules
├── decode_string_array
├── constant_fold
└── remove_dead_code
```

建議：

> 優先研究，甚至可以考慮早期直接整合，而不是自己從零寫完整 JavaScript deobfuscator。

---

## 44.2 bundle-breaker

專案：

```text
https://github.com/awphi/bundle-breaker
```

定位：

```text
Bundled JavaScript Reverse Engineering
```

主要價值在於：

- Bundle 拆解
- Module grouping
- Function / module naming
- Pruning
- 人工分析 bundled code

對本專案特別有參考價值的是：

```text
Module Explorer
Code Navigation
Manual Rename
Bundle Structure
```

本專案 GUI 可以提供：

```text
Module 4278
├── Imports
├── Exports
├── Callers
├── Callees
├── Rename
├── Notes
├── Evidence
└── Ask AI
```

---

# 45. Playwright

官方：

```text
https://playwright.dev/
```

Playwright 應該是本專案 Browser Runtime 的主要候選。

它已經提供成熟能力：

- Chromium automation
- DOM locator
- Accessibility-based locator
- Input
- Click
- File Upload
- Download
- Request / Response monitoring
- Request interception
- Browser context
- Cookies
- Storage
- Screenshot
- Trace

本專案不需要重新實作基本瀏覽器 automation。

建議：

```text
Browser Runtime
=
Playwright
+
Chrome DevTools Protocol
```

Playwright 負責高階操作。

CDP 負責更底層的 instrumentation。

---

# 46. Playwright Trace Viewer

Playwright Trace Viewer 是非常重要的 UI / Data Model 參考。

它已經具備：

```text
Action Timeline
Screenshot
DOM Snapshot
Network
Console
Before / After State
```

這和本專案想做的：

```text
Action
↓
Network
↓
DOM
↓
Storage
↓
JS
```

非常接近。

本專案可以借鑑 Trace Viewer 的 Timeline 思路，但加入：

```text
JS Initiator
Webpack Module
Function
Storage Diff
Evidence
Dependency Graph
LLM Explanation
```

形成更偏 reverse engineering 的 Trace Viewer。

---

# 47. Chrome DevTools Protocol

官方：

```text
https://chromedevtools.github.io/devtools-protocol/
```

CDP 是 Chromium instrumentation 的底層核心。

可以提供：

- DOM
- Runtime
- Debugger
- Network
- Storage
- Performance
- Page
- Target
- WebSocket events
- Console
- Execution Context

本專案很多進階功能最後都會需要 CDP。

例如：

```text
Function breakpoint
XHR breakpoint
Call Stack
Runtime variable inspection
Network request initiator
Execution context
```

因此架構應避免只依賴 Playwright 高階 API。

推薦：

```text
Playwright
= 操作層

CDP
= instrumentation / debugger 層
```

---

# 48. mitmproxy

官方：

```text
https://mitmproxy.org/
```

文件：

```text
https://docs.mitmproxy.org/
```

mitmproxy 的「Flow」概念非常值得借鑑。

一個 Flow 可以包含：

```text
Request
Response
Timing
Metadata
Interception State
```

它也提供：

- Request modification
- Response modification
- Replay
- Save
- Script
- Filter

本專案 Network Inspector 可以參考其資料模型。

例如：

```text
Network Flow

req_102
├── Request
├── Response
├── Timing
├── Initiator
├── Action ID
├── Replay
├── Clone
├── Modify
├── Compare
└── Evidence
```

---

# 49. OWASP ZAP

官方：

```text
https://www.zaproxy.org/
```

ZAP 是一套成熟的 Web 分析 / Proxy / 安全測試工作台。

值得參考的不是漏洞掃描本身，而是：

- Desktop UI
- HTTP History
- Request Inspector
- Response Inspector
- WebSocket
- Proxy
- Manual Request Editor
- Session organization

這對「Human-first」介面設計很有參考價值。

本專案可以借鑑：

```text
左側資源
中間瀏覽器
右側 Inspector
底部 Timeline / Network
```

這種工作台形式。

---

# 50. Stagehand

專案：

```text
https://github.com/browserbase/stagehand
```

定位：

```text
AI Browser Automation
+
Deterministic Browser Automation
```

它值得借鑑的原因不是 browser automation 本身，而是：

> AI 控制與傳統程式控制可以共存。

這與本專案的：

```text
Human-first
AI-optional
```

方向高度一致。

本專案可以採用：

```text
Manual operation
↓
Optional AI assistance
↓
Optional Agent automation
```

而不是要求所有動作都經過 LLM。

---

# 51. Browser Use

專案：

```text
https://github.com/browser-use/browser-use
```

Browser Use 偏向：

```text
Agent-first Browser Automation
```

適合借鑑：

- LLM ↔ Browser Tool abstraction
- Browser observation
- Agent action loop
- Browser state extraction
- Tool calling schema

但不建議直接採用它的產品定位。

本專案核心仍然應是：

```text
Human-operated analysis platform
```

而不是：

```text
AI browser bot
```

---

# 52. Skyvern

專案：

```text
https://github.com/skyvern-ai/skyvern
```

主要方向：

```text
LLM
+
Computer Vision
+
Browser Automation
```

可借鑑：

- Vision-based UI interaction
- DOM 無法解析時的 fallback
- 複雜網站 workflow automation

本專案可以把 Vision 定位成：

```text
DOM
↓
Accessibility
↓
Playwright Locator
↓
JS
↓
Vision
↓
Mouse Coordinate
```

Vision 不應該成為第一選擇。

---

# 53. Reverse Engineering Browser 類專案

有開發者嘗試直接建立：

```text
Browser for Reverse Engineers
```

參考：

```text
https://nullpt.rs/reverse-engineering-browser
```

這個方向和本專案非常接近。

核心想法是：

```text
Chromium
+
CDP
+
Reverse Engineering UX
```

這代表本專案未來可能有兩種產品型態。

## 方案 A

```text
獨立 Web Reverse Engineering Tool
+
Embedded Chromium
```

## 方案 B

```text
Custom Reverse Engineering Browser
```

MVP 建議先走 A。

等工具成熟後，再評估是否需要發展成完整 Browser。

---

# 54. JSIMPLIFIER 類研究方向

已有研究嘗試結合：

```text
Static Analysis
+
Dynamic Execution
+
LLM
```

進行 JavaScript deobfuscation / simplification。

值得借鑑的核心不是特定模型，而是 Pipeline：

```text
Preprocessing
↓
AST Static Analysis
↓
Dynamic Execution Tracing
↓
LLM Semantic Understanding
↓
Identifier Renaming
```

這支持本專案的設計原則：

> 不應讓 LLM 直接處理完整混淆程式碼，而應先用傳統工具降低複雜度。

---

# 55. 建議的技術借鑑組合

本專案第一版可以把現有技術組合成：

```text
webcrack
    │
    │ JS deobfuscation / bundle unpack
    ▼
Static Analysis Engine


Playwright
    │
    │ Browser operation
    ▼
Browser Controller


Chrome DevTools Protocol
    │
    │ Runtime / Debugger / Network
    ▼
Instrumentation Layer


Playwright Trace Viewer
    │
    │ Action Timeline / Snapshot concept
    ▼
Investigation Timeline


mitmproxy / ZAP
    │
    │ HTTP Flow / Replay / Modify UX
    ▼
Network Workspace


bundle-breaker
    │
    │ Module navigation / naming
    ▼
Code Explorer


Stagehand / Browser Use / Skyvern
    │
    │ Optional AI automation
    ▼
AI Assistant / Agent Mode
```

---

# 56. 本專案真正的差異化方向

上述工具各自都很強。

例如：

```text
Chrome DevTools
→ Runtime / Network / DOM

mitmproxy
→ HTTP Flow

webcrack
→ JavaScript Deobfuscation

Playwright
→ Browser Automation

Browser Use
→ AI 操作瀏覽器
```

但它們通常沒有把所有資訊建立成同一條完整因果鏈。

本專案最值得發展的能力是：

```text
UI Action
↓
DOM Event
↓
JavaScript Function
↓
Webpack / Bundle Module
↓
Request Builder
↓
HTTP / WebSocket Request
↓
Response
↓
State / Storage Update
↓
Component Re-render
↓
DOM Change
```

例如：

```text
使用者點擊「搜尋」
        │
        ▼
SearchButton.onclick
        │
        ▼
handleSearch()
        │
        ▼
module 8271
        │
        ▼
buildSearchPayload()
        │
        ▼
POST /api/search
        │
        ▼
response.items
        │
        ▼
store.results
        │
        ▼
SearchResultList render
```

這條：

```text
Cross-layer Investigation Graph
```

可能會成為整個產品最重要的核心價值。

---

# 57. 產品定位更新

因此，本專案不應只被定位成：

```text
AI Browser Agent
```

也不應只是：

```text
JavaScript Deobfuscator
```

更合理的定位是：

> **ARC — Analysis & Runtime Cartography**

核心：

```text
Human-operated Investigation
```

附加：

```text
AI-assisted Investigation
```

進階：

```text
Agent-driven Investigation
```

三者共用：

```text
Core Tools
Evidence
Investigation Graph
Session Data
```

---

# 58. 建議優先研究順序

第一優先：

```text
Playwright
Chrome DevTools Protocol
Playwright Trace Viewer
```

因為這三個決定 Browser Runtime 與 Action Timeline。

第二優先：

```text
webcrack
bundle-breaker
```

決定 JavaScript / Bundle 分析能力。

第三優先：

```text
mitmproxy
OWASP ZAP
```

決定 Network Workspace 與人工操作 UX。

第四優先：

```text
Stagehand
Browser Use
Skyvern
```

用來設計 optional LLM / Agent layer。

---

# 59. 初期避免重造的輪子

MVP 不建議自行重新實作：

- Chromium browser engine
- DOM selector engine
- HTTP proxy
- JavaScript parser
- AST format
- Basic JavaScript beautifier
- HAR format
- Screenshot engine
- Browser file upload
- Download handling

應優先站在現有工具上。

真正值得自行開發的是：

```text
Cross-layer Correlation
Investigation Graph
Unified Timeline
Human Analysis UX
Evidence System
LLM Tool Interface
```

這些才是本專案最有差異化的地方。
