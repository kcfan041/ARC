/**
 * 工具契約
 *
 * 對應 REVIEW.md 的 C3（Blocker）：
 *   「69 個工具全無簽章。沒有 schema 就無法定義共用介面，
 *     也無法做 LLM tool-calling。」
 *
 * 採用 MCP（Model Context Protocol）的 Tool 格式，
 * 因此 ARC 的工具可直接被 Claude Desktop 等 MCP client 使用，
 * 也不需要教 LLM 一套自創的 schema。
 *
 * ── 兩套機制必須嚴格分離 ──────────────────────────────
 *
 * MCP 規格明文要求：
 *   clients MUST consider tool annotations to be untrusted
 *   unless they come from trusted servers.
 *
 * 因此：
 *   annotations    工具自述 → 不可信 → 只用於 UI 顯示與 LLM 理解
 *   capabilities   宣告 + 執行期注入 → 強制機制 → 決定實際拿得到什麼
 *
 * 一個工具可以謊稱 readOnlyHint: true，
 * 但它拿不到未宣告的能力 —— 因為那個函式根本不存在於它的作用域。
 *
 * 這符合 MVP1-PLAN.md 3.8 的上界原則：
 *   政策「不准做 X」          → 不做
 *   機制「宣告 A 就只給 A」   → 這是最小權限，是機制
 *
 * core-tools 本身仍然零限制，人工呼叫路徑不受影響。
 */

/** JSON Schema 子集。MCP 的 inputSchema / outputSchema 使用此格式。 */
export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
  [k: string]: unknown;
};

/**
 * 能力識別碼
 *
 * 工具宣告它需要哪些 core-tools 原語，
 * 執行時 runtime 只注入這些，其餘拿不到。
 */
export type Capability =
  // 唯讀
  | 'session.read'      // actions / flows / bindings / status
  | 'network.read'      // 讀取 request / response
  | 'storage.read'      // cookie / localStorage
  | 'code.read'         // 已收集的 JS 資源
  // 有副作用
  | 'browser.navigate'  // 導航
  | 'browser.interact'  // click / fill / press
  | 'network.replay'    // 重放請求
  | 'browser.eval';     // 頁面內執行任意程式碼

/** 唯讀能力集合。用於判斷工具是否需要人工確認（P4 信任模型）。 */
export const READ_ONLY_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'session.read',
  'network.read',
  'storage.read',
  'code.read',
]);

export function isReadOnlyTool(t: ToolDefinition): boolean {
  return t.capabilities.every((c) => READ_ONLY_CAPABILITIES.has(c));
}

/**
 * MCP annotations —— 不可信的行為提示
 *
 * 僅供 UI 與 LLM 參考。任何安全決策都不得依賴此欄位，
 * 一律以 capabilities 為準。
 */
export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** 工具的三種執行方式。對 LLM 而言介面完全相同。 */
export type ToolTier =
  | 'primitive'    // 內建原語，直接呼叫 core-tools
  | 'declarative'  // Tier 1：宣告式組合，無程式碼執行
  | 'sandboxed'    // Tier 2：QuickJS 沙箱（P2）
  | 'external';    // Tier 3：外部 MCP Server（P4）

/** 工具來源。用於 P4 的信任鏈。 */
export type ToolOrigin = {
  kind: 'builtin' | 'user' | 'ai-generated' | 'imported';
  /** 匯入來源，例如 MCP server 名稱或檔案路徑 */
  from?: string;
  /** 人工是否已確認過此工具的能力宣告 */
  approvedAt?: number;
};

/**
 * 工具定義
 *
 * 欄位與 MCP Tool 對齊（name / title / description /
 * inputSchema / outputSchema / annotations / _meta），
 * 額外加上 ARC 專屬的 capabilities / tier / origin / scope。
 *
 * 對外以 MCP 格式暴露時，ARC 專屬欄位會被放進 _meta，
 * 不破壞協定相容性。
 */
export type ToolDefinition = {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;

  /** ★ 強制機制。執行時只注入這些能力。 */
  capabilities: Capability[];

  tier: ToolTier;
  origin: ToolOrigin;

  /**
   * 作用域。只有情境相符時才進入 LLM 的 context。
   *
   * 解決「幾百個工具」的 context 爆炸問題：
   *   300 工具 × 200 tokens = 60,000 tokens，還沒開工就滿了。
   *   對應原規格書 §37「不要把整個網站一次放入 prompt」。
   */
  scope?: {
    /** 網域比對，支援 *.example.com */
    domain?: string;
    /** 自由標籤，供 find_tools 檢索 */
    tags?: string[];
  };
};

/**
 * 統一回傳信封
 *
 * 對應 REVIEW.md C3 建議的 ToolResult<T>。
 * 截斷是簽章的一部分，不能靠呼叫端自律 ——
 * 否則 §37 的 context 控制原則會自動失效。
 */
export type ToolResult<T = unknown> =
  | {
      ok: true;
      data: T;
      truncated?: {
        reason: 'size_limit' | 'count_limit';
        returned: number;
        total: number;
        cursor?: string;
      };
    }
  | {
      ok: false;
      error: {
        code: ToolErrorCode;
        message: string;
        retryable: boolean;
      };
    };

export type ToolErrorCode =
  | 'NOT_FOUND'
  | 'STALE_REFERENCE'
  | 'TIMEOUT'
  | 'PERMISSION_REQUIRED'
  | 'CAPABILITY_DENIED'
  | 'PARSE_FAILED'
  | 'BROWSER_NOT_READY'
  | 'INVALID_ARGUMENT'
  | 'EXECUTION_FAILED';

export function ok<T>(data: T, truncated?: Extract<ToolResult<T>, { ok: true }>['truncated']): ToolResult<T> {
  return truncated ? { ok: true, data, truncated } : { ok: true, data };
}

export function fail(
  code: ToolErrorCode,
  message: string,
  retryable = false,
): ToolResult<never> {
  return { ok: false, error: { code, message, retryable } };
}

/** 全域預設。對應 REVIEW.md C3 的「全域預設」建議。 */
export const TOOL_LIMITS = {
  /** 單次回傳上限，可由呼叫端覆寫 */
  maxResponseBytes: 256 * 1024,
  /** 列表類預設筆數 */
  defaultPageSize: 100,
  /** 單次工具執行逾時 */
  timeoutMs: 30_000,
} as const;
