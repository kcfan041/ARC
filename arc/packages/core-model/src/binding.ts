/**
 * Action ↔ Network 綁定
 *
 * 對應 MVP1-PLAN.md 2.2.A 的核心功能，以及 2.6 指出的
 * 「Chrome DevTools 的 Recorder 面板與 Network 面板不互通」這一缺口。
 */

export type StrategyName =
  | 'A-window'
  | 'B-initiator'
  | 'C-periodic'
  | 'D-rhythm';

export type Binding = {
  actionId: string;
  flowIds: string[];
  strategy: StrategyName;
  /** 使用的時間窗（毫秒） */
  windowMs: number;
};

/** 單一策略在單一時間窗下的量測結果 */
export type StrategyScore = {
  strategy: StrategyName;
  windowMs: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
};

export function scoreOf(
  strategy: StrategyName,
  windowMs: number,
  tp: number,
  fp: number,
  fn: number,
): StrategyScore {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    strategy,
    windowMs,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision,
    recall,
    f1,
  };
}

/**
 * 判定標準（SPIKES.md S1.5）
 *
 *   通過      precision > 0.8 且 recall > 0.9
 *   有條件    recall >= 0.7 但未達通過標準
 *             → UI 標示「可能相關」並允許使用者排除
 *             → 因為漏掉比多抓更嚴重
 *   不通過    recall < 0.7
 *             → Timeline 降級為輔助功能
 *
 * 註：初版實作曾把 recall 落在 0.7-0.9 之間者判為 fail，
 *     導致 precision 87.5% / recall 87.5% 被標成失敗。
 *     那不符合 SPIKES.md 的定義 —— fail 的唯一條件是 recall < 0.7。
 */
export type Verdict = 'pass' | 'conditional' | 'fail';

export const RECALL_FLOOR = 0.7;

export function verdictOf(s: StrategyScore): Verdict {
  if (s.recall < RECALL_FLOOR) return 'fail';
  if (s.precision > 0.8 && s.recall > 0.9) return 'pass';
  return 'conditional';
}
