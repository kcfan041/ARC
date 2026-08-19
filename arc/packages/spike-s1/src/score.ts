import type { ActionRecord, Binding, FlowRecord, StrategyName } from '@arc/core-model';
import { scoreOf, type StrategyScore } from '@arc/core-model';

/**
 * 量測評分
 *
 * ground truth 的來源：
 *   fixture 每個由操作觸發的 request 都帶 marker 參數，
 *   marker 值等於案例中宣告的 expect 內容。
 *   雜訊（輪詢、prefetch）的 marker 以 "noise-" 開頭。
 *
 * 因此不需要人工判讀 —— 正確答案由建構方式決定。
 */

export type ExpectedBinding = {
  /** 觸發的按鈕 id，例如 c1-btn */
  buttonId: string;
  /** 該操作應綁定的 marker 清單 */
  markers: string[];
};

export type CaseOutcome = {
  actionId: string;
  buttonId: string;
  expected: string[];
  got: string[];
  missing: string[];
  extra: string[];
};

/** 一個 flow 是否為雜訊（不應被任何 action 綁定） */
export function isNoise(marker: string | undefined): boolean {
  return !!marker && marker.startsWith('noise-');
}

export function evaluate(
  strategy: StrategyName,
  windowMs: number,
  actions: ActionRecord[],
  flows: FlowRecord[],
  bindings: Binding[],
  expectations: ExpectedBinding[],
): { score: StrategyScore; outcomes: CaseOutcome[] } {
  const flowById = new Map(flows.map((f) => [f.id, f]));
  const bindingByAction = new Map(bindings.map((b) => [b.actionId, b]));

  let tp = 0;
  let fp = 0;
  let fn = 0;
  const outcomes: CaseOutcome[] = [];

  // 依序把 expectation 對到 action。
  // action 的順序即操作順序，因此可用 selector 比對。
  for (const exp of expectations) {
    const action = actions.find(
      (a) =>
        a.target.id === exp.buttonId &&
        !outcomes.some((o) => o.actionId === a.id),
    );

    if (!action) {
      // 操作完全沒被記錄到，expect 的每一項都算漏掉
      fn += exp.markers.length;
      outcomes.push({
        actionId: '(未記錄到 action)',
        buttonId: exp.buttonId,
        expected: exp.markers,
        got: [],
        missing: exp.markers,
        extra: [],
      });
      continue;
    }

    const bound = bindingByAction.get(action.id)?.flowIds ?? [];
    const gotMarkers = bound
      .map((id) => flowById.get(id)?.marker)
      .filter((m): m is string => !!m);

    const expectedSet = new Set(exp.markers);
    const gotSet = new Set(gotMarkers);

    const missing = [...expectedSet].filter((m) => !gotSet.has(m));
    const extra = [...gotSet].filter((m) => !expectedSet.has(m));

    tp += [...expectedSet].filter((m) => gotSet.has(m)).length;
    fn += missing.length;
    fp += extra.length;

    outcomes.push({
      actionId: action.id,
      buttonId: exp.buttonId,
      expected: exp.markers,
      got: [...gotSet],
      missing,
      extra,
    });
  }

  return { score: scoreOf(strategy, windowMs, tp, fp, fn), outcomes };
}
