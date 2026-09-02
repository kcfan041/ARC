import type { Capability, ToolDefinition } from './tool.js';

/**
 * 工具封裝格式
 *
 * 用於匯出、分享、匯入。只有 Tier 1（宣告式）與 Tier 2（沙箱）
 * 可以封裝 —— 原語的行為在程式碼裡，不是資料。
 *
 * ── 「匯入」其實是兩件事 ──────────────────────────────
 *
 *   檔案匯入        一份 ToolPackage，內容可完整審查
 *                   → 進入本機 registry，需要人工核准
 *
 *   連接 MCP Server 透過協定取得別人的工具（Tier 3）
 *                   → 執行發生在對方程序，我方看不到實作
 *
 * 兩者的信任模型完全不同，因此格式與流程分開處理。
 * 本檔只負責前者。
 */

/** 封裝格式版本。日後結構改變時用於相容性判斷。 */
export const TOOL_PACKAGE_VERSION = 1;

export type ToolPackage = {
  /** 固定為 "arc.tool-package"，用於辨識檔案類型 */
  kind: 'arc.tool-package';
  version: number;
  /** 工具定義。tier 只能是 declarative 或 sandboxed。 */
  def: ToolDefinition;
  /** 執行規格。Tier 1 為 DeclarativeSpec，Tier 2 為 SandboxedSpec。 */
  spec: unknown;
  /**
   * 內容雜湊，涵蓋 def 與 spec。
   *
   * 用途不是防竄改（攻擊者可同時改內容與雜湊），
   * 而是偵測傳輸損毀，以及讓「核准」能綁定到具體內容 ——
   * 工具改變後先前的核准即失效。
   */
  integrity: string;
  exportedAt: number;
  /** 匯出者自述。與 annotations 同樣不可信，僅供顯示。 */
  exportedBy?: string;
};

/**
 * 匯入前的檢查結果。
 *
 * 這是呈現給使用者的「確認畫面」所需的全部資訊 ——
 * 對應 MVP1-PLAN 3A.8 的信任模型：
 *   匯入時顯示該工具宣告了哪些能力，人工確認一次。
 */
export type ImportReview = {
  def: ToolDefinition;
  /** 該工具宣告的能力，以及各自是否為唯讀 */
  capabilities: { name: Capability; readOnly: boolean }[];
  /** 全部能力皆唯讀時為 true。可作為免確認的依據。 */
  allReadOnly: boolean;
  /** 與本機既有工具同名 */
  nameConflict: boolean;
  /** 內容雜湊與宣告值不符，可能是傳輸損毀 */
  integrityMismatch: boolean;
  /** 阻擋匯入的問題。非空時不應允許匯入。 */
  blockers: string[];
  /** 不阻擋但應提醒使用者的事項 */
  warnings: string[];
};

/** 判斷封裝是否為合法結構。用於匯入前的基本驗證。 */
export function isToolPackage(v: unknown): v is ToolPackage {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    p.kind === 'arc.tool-package' &&
    typeof p.version === 'number' &&
    !!p.def &&
    typeof p.def === 'object' &&
    typeof p.integrity === 'string'
  );
}
