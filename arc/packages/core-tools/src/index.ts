/**
 * Core Tools — 唯一對外介面
 *
 * MVP1-PLAN.md 3.3：完整能力，零限制。
 * 不含任何政策判定（無關鍵字清單、無 content-type 分類、
 * 無授權狀態、無 method 白名單）。
 *
 * 限制屬於 agent-facade，不屬於這一層。
 */
export * from './session.js';

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
} from '@arc/core-model';
