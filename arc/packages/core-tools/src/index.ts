/**
 * Core Tools — 唯一對外介面
 *
 * MVP1-PLAN.md 3.3：完整能力，零限制。
 * 不含任何政策判定（無關鍵字清單、無 content-type 分類、
 * 無授權狀態、無 method 白名單）。
 *
 * 限制屬於 agent-facade，不屬於這一層。
 *
 * ── 兩個並列的概念 ────────────────────────────────────
 *
 *   Session    資源生命週期（瀏覽器、訂閱、計時器）+ 事件串流
 *   Registry   工具的宣告、發現、呼叫、capability 注入
 *   Workspace  兩者的組合，多數呼叫端用這個
 *
 * Session 不是 Registry 的過渡層。MCP 是請求／回應模型，
 * 沒有對應「事件串流」，而串流正是 ARC 的核心價值。
 */
export * from './session.js';
export * from './primitives.js';
export * from './workspace.js';

// 型別轉出，讓 gui / cli 不需直接依賴 core-model
export type {
  ActionRecord,
  ActionKind,
  ActionTarget,
  Binding,
  FlowRecord,
  FlowInitiator,
  StrategyName,
  EpochMs,
  ToolDefinition,
  ToolResult,
  ToolErrorCode,
  Capability,
  ToolTier,
  ToolOrigin,
  ToolAnnotations,
} from '@arc/core-model';

export { isReadOnlyTool, READ_ONLY_CAPABILITIES, TOOL_LIMITS } from '@arc/core-model';
export {
  AGENT_DEFAULT_CAPABILITIES,
  matchDomain,
  type DeclarativeSpec,
  type DeclarativeStep,
  type ExecutionMode,
} from '@arc/tool-runtime';
