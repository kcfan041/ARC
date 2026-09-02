import type { ToolDefinition, ToolResult } from '@arc/core-model';
import { fail, ok } from '@arc/core-model';

/**
 * Tier 1：宣告式執行
 *
 * 這一層取代了 MVP1-PLAN.md 3.4 原本獨立的「採集規格」——
 * 採集規格現在只是宣告式工具的一種，不再是特例。
 * 是整併，不是新增。
 *
 * 安全性質（MVP1-PLAN.md 3.4）：
 *   method / origin / headers 一律沿用原始 request，
 *   只有 vary 中明確列出的參數可以改變。
 *   因此宣告式工具在結構上無法呼叫
 *   「網站自己沒有呼叫過」的端點。
 *
 * 不執行任何程式碼，因此不需要沙箱。
 */

export type DeclarativeStep =
  | {
      kind: 'replay';
      /** 必須是本 session 實際觀測到的 request */
      sourceFlow: string;
      /** 只有列在這裡的參數可以改變 */
      vary?: Record<string, VarySpec>;
      /** 從 response 抽取資料的 JSONPath 子集 */
      extract?: string;
      /** 結果存入變數，供後續 step 使用（chained spec） */
      as?: string;
      limit?: { maxRequests?: number; ratePerSec?: number };
    }
  | {
      kind: 'filter';
      /** 對已觀測的 flow 做過濾，完全不發送請求 */
      urlContains?: string;
      method?: string;
      resourceType?: string;
      extract?: string;
      as?: string;
    };

export type VarySpec =
  | { from: number; to: number; step?: number }
  | { values: unknown[] }
  | { fromVar: string };

export type DeclarativeSpec = {
  steps: DeclarativeStep[];
};

/**
 * 宣告式工具需要的執行環境。
 *
 * 由 capability 注入提供 —— 工具只拿得到宣告過的部分。
 */
export type DeclarativeScope = {
  /** session.read */
  listFlows?: () => unknown[];
  getFlow?: (id: string) => unknown;
  /** network.replay */
  replay?: (
    flowId: string,
    changes: Record<string, unknown>,
  ) => Promise<{ status: number; body: unknown }>;
};

export type ExecutionMode = 'dry-run' | 'probe' | 'full';

export type DeclarativeResult = {
  mode: ExecutionMode;
  /** dry-run 時列出將送出的請求，不實際發送 */
  planned: { flowId: string; changes: Record<string, unknown> }[];
  results: unknown[];
  stoppedReason?: string;
};

/**
 * 展開 vary 規格為具體的參數組合。
 */
export function expandVary(
  vary: Record<string, VarySpec>,
  vars: Record<string, unknown[]>,
): Record<string, unknown>[] {
  const keys = Object.keys(vary);
  if (keys.length === 0) return [{}];

  let combos: Record<string, unknown>[] = [{}];

  for (const key of keys) {
    const spec = vary[key]!;
    let values: unknown[];

    if ('values' in spec) {
      values = spec.values;
    } else if ('fromVar' in spec) {
      values = vars[spec.fromVar] ?? [];
    } else {
      values = [];
      const step = spec.step ?? 1;
      for (let v = spec.from; v <= spec.to; v += step) values.push(v);
    }

    const next: Record<string, unknown>[] = [];
    for (const combo of combos) {
      for (const v of values) next.push({ ...combo, [key]: v });
    }
    combos = next;
  }

  return combos;
}

/**
 * 極簡 JSONPath 子集。
 *
 * 支援：$.a.b  /  $.items[*].url  /  $.items[0].id
 * 刻意不支援完整 JSONPath —— 表達力越強，越難靜態驗證，
 * 而這一層的價值正是「可驗證」。
 */
export function extractPath(data: unknown, path: string): unknown[] {
  if (!path || path === '$') return [data];
  const parts = path.replace(/^\$\.?/, '').split('.');
  let current: unknown[] = [data];

  for (const raw of parts) {
    if (!raw) continue;
    const m = /^([^[]*)(?:\[(\*|\d+)\])?$/.exec(raw);
    if (!m) return [];
    const [, key, index] = m;

    const next: unknown[] = [];
    for (const item of current) {
      let v: unknown = item;
      if (key) {
        if (typeof v !== 'object' || v === null) continue;
        v = (v as Record<string, unknown>)[key];
      }
      if (index === undefined) {
        if (v !== undefined) next.push(v);
      } else if (index === '*') {
        if (Array.isArray(v)) next.push(...v);
      } else {
        if (Array.isArray(v)) {
          const picked = v[Number(index)];
          if (picked !== undefined) next.push(picked);
        }
      }
    }
    current = next;
  }

  return current;
}

/**
 * 執行宣告式規格。
 *
 * 三段式（MVP1-PLAN.md 3.5）：
 *   dry-run  完全不發請求，只列出將送出什麼
 *   probe    只發 1 次，確認抽取規則正確
 *   full     執行剩餘次數
 *
 * LLM 產生的規格強制走完三段；人工可直接跳到 full。
 */
export async function runDeclarative(
  spec: DeclarativeSpec,
  scope: DeclarativeScope,
  mode: ExecutionMode = 'dry-run',
): Promise<ToolResult<DeclarativeResult>> {
  const planned: DeclarativeResult['planned'] = [];
  const results: unknown[] = [];
  const vars: Record<string, unknown[]> = {};
  let stoppedReason: string | undefined;

  for (const step of spec.steps) {
    if (step.kind === 'filter') {
      if (!scope.listFlows) {
        return fail('CAPABILITY_DENIED', 'filter requires session.read');
      }
      let flows = scope.listFlows() as Record<string, unknown>[];
      if (step.urlContains) {
        const needle = step.urlContains;
        flows = flows.filter((f) => String(f.url ?? '').includes(needle));
      }
      if (step.method) {
        flows = flows.filter((f) => f.method === step.method);
      }
      if (step.resourceType) {
        flows = flows.filter((f) => f.resourceType === step.resourceType);
      }
      const out = step.extract
        ? flows.flatMap((f) => extractPath(f, step.extract!))
        : flows;
      if (step.as) vars[step.as] = out;
      results.push(...out);
      continue;
    }

    // kind === 'replay'
    if (!scope.getFlow) {
      return fail('CAPABILITY_DENIED', 'replay requires session.read');
    }
    const source = scope.getFlow(step.sourceFlow);
    if (!source) {
      // 機械驗證：source_flow 必須真實存在於本 session。
      // 這是「LLM 不得憑空產生 URL」的執行層強制點。
      return fail(
        'NOT_FOUND',
        `sourceFlow "${step.sourceFlow}" not found in this session`,
      );
    }

    const combos = expandVary(step.vary ?? {}, vars);
    const max = step.limit?.maxRequests ?? combos.length;
    const toRun = combos.slice(0, max);

    for (const changes of toRun) {
      planned.push({ flowId: step.sourceFlow, changes });
    }

    if (mode === 'dry-run') continue;

    if (!scope.replay) {
      return fail('CAPABILITY_DENIED', 'replay requires network.replay');
    }

    const runCount = mode === 'probe' ? Math.min(1, toRun.length) : toRun.length;
    const rate = step.limit?.ratePerSec ?? 1;
    const gapMs = Math.max(0, Math.round(1000 / rate));

    for (let i = 0; i < runCount; i += 1) {
      const changes = toRun[i]!;
      const res = await scope.replay(step.sourceFlow, changes);

      // 自動中止：收到 429 之後仍繼續發送，
      // 是「採集」與「攻擊」的實質分界線（MVP1-PLAN 3.6）
      if (res.status === 429 || res.status === 403) {
        stoppedReason = `stopped on HTTP ${res.status}`;
        break;
      }

      const out = step.extract ? extractPath(res.body, step.extract) : [res.body];
      results.push(...out);
      if (step.as) vars[step.as] = (vars[step.as] ?? []).concat(out);

      if (i < runCount - 1 && gapMs > 0) {
        await new Promise((r) => setTimeout(r, gapMs));
      }
    }

    if (stoppedReason) break;
  }

  const result: DeclarativeResult = { mode, planned, results };
  if (stoppedReason) result.stoppedReason = stoppedReason;
  return ok(result);
}

/**
 * 把宣告式規格包裝成一個具名工具。
 *
 * 這就是「AI 寫的工具」與「匯入的工具」在 Tier 1 的形式 ——
 * 純資料，可儲存、可傳輸、可審查，不含程式碼。
 */
export function defineDeclarativeTool(
  meta: Omit<ToolDefinition, 'tier' | 'capabilities'> & {
    capabilities?: ToolDefinition['capabilities'];
  },
  spec: DeclarativeSpec,
): { def: ToolDefinition; spec: DeclarativeSpec } {
  const needsReplay = spec.steps.some((s) => s.kind === 'replay');
  return {
    def: {
      ...meta,
      tier: 'declarative',
      capabilities:
        meta.capabilities ??
        (needsReplay ? ['session.read', 'network.replay'] : ['session.read']),
    },
    spec,
  };
}
