import type { EpochMs } from './time.js';

/**
 * 使用者操作記錄
 *
 * 對應 MVP1-PLAN.md 2.2.A 與 2.4。
 *
 * 設計決定（2.4）：
 *   只記錄「原始手勢」，不追框架 handler。
 *   理由：React 17+ 將事件委派到 root container，
 *        DOMBugger.getEventListeners(<button>) 回傳空陣列，
 *        對 root 查詢則對所有按鈕回傳同一答案，零資訊。
 *   因此改以 capture-phase listener 掛在 document 上，
 *   這條路徑與框架無關。
 */
export type ActionKind =
  | 'click'
  | 'input'
  | 'change'
  | 'submit'
  | 'keydown'
  | 'scroll';

export type ActionTarget = {
  /** 由注入腳本產生的 selector，盡量穩定但不保證唯一 */
  selector: string;
  tag: string;
  text?: string;
  /** 常見的識別屬性，用於人工判讀 */
  id?: string;
  name?: string;
  role?: string;
  type?: string;
};

export type ActionRecord = {
  /** action_1, action_2, ... */
  id: string;
  kind: ActionKind;
  target: ActionTarget;
  /** 統一時基（Unix epoch 毫秒） */
  at: EpochMs;
  /** 事件發生時的頁面 URL */
  pageUrl: string;
  /**
   * 由 fixture 標註的預期綁定，僅供 S1 量測使用。
   * 產品程式碼不應依賴此欄位。
   */
  expectedFlowMarkers?: string[];
};
