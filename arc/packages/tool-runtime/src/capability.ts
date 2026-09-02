import type { Capability, ToolDefinition } from '@arc/core-model';

/**
 * Capability 注入
 *
 * 這是整個工具框架的安全基礎。
 *
 * 核心性質（已於 QuickJS 實測驗證）：
 *   未宣告的能力不是「被禁止」，而是「不存在」。
 *
 *     network_list  → "function"    已宣告，注入
 *     browser_eval  → "undefined"   未宣告，不在作用域內
 *
 * 對比之下，MCP 的 annotations（readOnlyHint 等）是工具自述，
 * MCP 規格明文要求視為不可信。一個工具大可謊稱自己唯讀，
 * 但它無法取得沒有被注入的函式。
 *
 * 對應 MVP1-PLAN.md 3.8 的上界原則：
 *   這是最小權限（機制），不是行為黑名單（政策）。
 *   core-tools 本身仍零限制，人工路徑不受影響。
 */

/** 一個能力對應到的實作函式集合 */
export type CapabilityProvider = Record<string, (...args: any[]) => unknown>;

/** 能力名稱 → 該能力提供的函式 */
export type CapabilityMap = Partial<Record<Capability, CapabilityProvider>>;

/**
 * 依工具宣告建立受限的執行作用域。
 *
 * 只把宣告過的能力所對應的函式放進回傳物件；
 * 未宣告者完全不出現 —— 不是設成 undefined，而是不存在該 key。
 */
export function buildScope(
  tool: ToolDefinition,
  available: CapabilityMap,
): { scope: Record<string, unknown>; missing: Capability[] } {
  const scope: Record<string, unknown> = Object.create(null);
  const missing: Capability[] = [];

  for (const cap of tool.capabilities) {
    const provider = available[cap];
    if (!provider) {
      missing.push(cap);
      continue;
    }
    for (const [fnName, fn] of Object.entries(provider)) {
      scope[fnName] = fn;
    }
  }

  return { scope, missing };
}

/**
 * 檢查工具宣告的能力是否都在允許範圍內。
 *
 * 用於 agent-facade：LLM 可用的工具集合可能比人工更窄。
 * 例如 MVP1 決定不對 LLM 開放 browser.eval（MVP1-PLAN 3.4）。
 */
export function checkAllowed(
  tool: ToolDefinition,
  allowed: ReadonlySet<Capability>,
): { allowed: true } | { allowed: false; denied: Capability[] } {
  const denied = tool.capabilities.filter((c) => !allowed.has(c));
  return denied.length === 0 ? { allowed: true } : { allowed: false, denied };
}

/**
 * LLM 預設可用的能力集合。
 *
 * 刻意不含 browser.eval —— 對應 MVP1-PLAN.md 3.4 的決定：
 *   「LLM 只能輸出宣告式規格。人工可在 GUI 中自由撰寫並執行任意腳本。」
 *
 * 待 S2 得出宣告式模型的實際覆蓋率後，再決定是否放寬。
 */
export const AGENT_DEFAULT_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'session.read',
  'network.read',
  'storage.read',
  'code.read',
  'browser.navigate',
  'browser.interact',
  'network.replay',
]);
