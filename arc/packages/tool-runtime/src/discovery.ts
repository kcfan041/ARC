import type { Capability, ToolDefinition } from '@arc/core-model';

/**
 * 工具檢索與分層揭露
 *
 * ── 要解決的問題（MVP1-PLAN 3A.6）────────────────────
 *
 *   300 工具 × 每個 schema 約 200 tokens = 60,000 tokens
 *   → 還沒開始工作，context 就滿了
 *   → 直接違反原規格書 §37 的 context 控制原則
 *
 * ── 三段式解法 ────────────────────────────────────────
 *
 *   1. 分層揭露   常駐核心工具（永遠可見）
 *                 其餘只給名稱與一行摘要，需要時才展開
 *   2. 作用域啟動 只有情境相符的工具進入 context
 *   3. 主動檢索   find_tools(intent) 由 LLM 自行縮小範圍
 *
 * ── 為何檢索用關鍵字而非嵌入向量 ──────────────────────
 *
 * 嵌入需要額外的 model 與向量儲存，而在數百個工具的規模下，
 * 「名稱 + 描述 + 標籤」的加權比對已足夠。
 *
 * 更關鍵的是：LLM 本身就是最好的語意檢索器。
 * find_tools 只需把候選縮到合理數量，最終選擇交給模型 ——
 * 因此檢索的目標是高召回而非高精確。
 */

/** 永遠出現在 context 中的核心工具。其餘需經檢索。 */
export const ALWAYS_VISIBLE = new Set([
  'session_status',
  'action_list',
  'network_list',
  'network_get',
  'network_get_body',
  'action_get_effects',
  'find_tools',
]);

/** 摘要形式。用於分層揭露的第一層，成本約為完整 schema 的十分之一。 */
export type ToolSummary = {
  name: string;
  title?: string;
  /** 描述的第一句，通常已足以判斷是否相關 */
  brief: string;
  tier: string;
  tags?: string[];
  /** 是否有副作用，供模型判斷是否需要謹慎 */
  readOnly: boolean;
};

export function summarise(
  def: ToolDefinition,
  readOnlyCaps: ReadonlySet<Capability>,
): ToolSummary {
  const brief = firstSentence(def.description);
  return {
    name: def.name,
    brief,
    tier: def.tier,
    readOnly:
      def.capabilities.length > 0 &&
      def.capabilities.every((c) => readOnlyCaps.has(c)),
    ...(def.title ? { title: def.title } : {}),
    ...(def.scope?.tags?.length ? { tags: def.scope.tags } : {}),
  };
}

function firstSentence(s: string): string {
  const trimmed = s.trim().replace(/\s+/g, ' ');
  const m = /^(.{0,110}?[。．.!?！？])\s/.exec(trimmed + ' ');
  return m ? m[1]! : trimmed.slice(0, 110);
}

export type SearchHit = {
  def: ToolDefinition;
  score: number;
  /** 命中原因，供人工判讀檢索品質 */
  matched: string[];
};

/**
 * 依意圖檢索工具。
 *
 * 評分權重的理由：
 *   名稱完全命中最可靠 —— 使用者或模型通常已知道工具叫什麼
 *   標籤次之 —— 那是刻意標註的分類
 *   描述最寬鬆 —— 容易誤命中，但漏掉的代價更高
 */
export function searchTools(
  tools: ToolDefinition[],
  intent: string,
  opts: { limit?: number; minScore?: number } = {},
): SearchHit[] {
  const limit = opts.limit ?? 10;
  const minScore = opts.minScore ?? 1;
  const terms = tokenise(intent);
  if (terms.length === 0) return [];

  const hits: SearchHit[] = [];

  for (const def of tools) {
    const name = def.name.toLowerCase();
    const nameTokens = new Set(tokenise(def.name));
    const desc = `${def.title ?? ''} ${def.description}`.toLowerCase();
    const tags = new Set((def.scope?.tags ?? []).map((t) => t.toLowerCase()));

    let score = 0;
    const matched: string[] = [];

    for (const term of terms) {
      if (name === term) {
        score += 10;
        matched.push(`name=${term}`);
      } else if (nameTokens.has(term)) {
        score += 5;
        matched.push(`name~${term}`);
      } else if (name.includes(term)) {
        score += 3;
        matched.push(`name*${term}`);
      }

      if (tags.has(term)) {
        score += 4;
        matched.push(`tag=${term}`);
      }

      if (desc.includes(term)) {
        score += 1;
        matched.push(`desc*${term}`);
      }
    }

    if (score >= minScore) hits.push({ def, score, matched });
  }

  return hits.sort((a, b) => b.score - a.score || a.def.name.localeCompare(b.def.name)).slice(0, limit);
}

/**
 * 切詞。
 *
 * 同時處理英文與中日韓字元 —— 後者不以空白分隔，
 * 因此以雙字元滑動窗切分，這對「影片」「請求」這類
 * 二字詞的命中率最好。
 */
function tokenise(s: string): string[] {
  const lower = s.toLowerCase();
  const out = new Set<string>();

  for (const m of lower.matchAll(/[a-z0-9_]+/g)) {
    const w = m[0];
    if (w.length >= 2) out.add(w);
    // 蛇底命名拆開，使 network_list 也能被 "network" 命中
    for (const part of w.split('_')) {
      if (part.length >= 2) out.add(part);
    }
  }

  const cjk = lower.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? [];
  for (const run of cjk) {
    if (run.length === 1) {
      out.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      out.add(run.slice(i, i + 2));
    }
  }

  return [...out];
}

export { tokenise };
