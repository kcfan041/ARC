import type { EpochMs, FlowRecord } from '@arc/core-model';

/**
 * 週期性請求偵測
 *
 * 目的是濾除輪詢 —— 它是 precision 的最大威脅，
 * 因為輪詢會落入任何操作的時間窗內。
 *
 * 提供兩個層次：
 *   detectPeriodicPatterns  哪些 URL pattern 是週期性的（策略 C 使用）
 *   fitSchedules            這些 pattern 的實際節奏（策略 D 使用）
 */

export type PeriodicOptions = {
  /** 至少要出現幾次才考慮判定為週期性 */
  minOccurrences?: number;
  /** 變異係數上限。越小越嚴格 */
  maxCoefficientOfVariation?: number;
};

/**
 * 預設值來自 GUI 原型的實測（2026-08-18）。
 *
 * 實測數據：
 *   真實輪詢 /api/poll     n=130  mean=700ms  cv=0.0010
 *   真實輪詢 /api/shared   n=101  mean=900ms  cv=0.0010
 *   使用者點擊 /api/data   n=  3  mean=2219ms cv=0.3168
 *
 * 兩者相差三個數量級。初版把閾值設在 0.35，
 * 導致三次間隔相近的使用者點擊（cv=0.317）被誤判為輪詢並濾除 ——
 * 這在 S1 的 fixture 量測中沒有暴露，因為當時每個案例只點一次。
 *
 * 調整：
 *   閾值 0.35 → 0.08   真實輪詢仍有 80 倍餘裕
 *   最少次數 3 → 5     三個點擊湊出「規律」的機率仍不低，
 *                      而真實輪詢在任何有意義的 session 中都遠超 5 次
 */
const DEFAULTS: Required<PeriodicOptions> = {
  minOccurrences: 5,
  maxCoefficientOfVariation: 0.08,
};

/**
 * 正規化 URL 為 pattern，用於分組。
 *
 * 去掉 query 中的變動值，只保留路徑與參數名。
 * 例如：
 *   /api/data?marker=noise-poll&t=123  →  /api/data?marker,t
 *
 * 已知限制（S1 的 c9 案例）：
 *   若輪詢與使用者操作共用同一端點且參數名相同，
 *   兩者會被歸為同一 pattern，無法區分。
 *   策略 D 用時間相位解決此問題。
 */
export function urlPattern(url: string): string {
  try {
    const u = new URL(url);
    const keys = [...u.searchParams.keys()].sort();
    return keys.length > 0
      ? `${u.origin}${u.pathname}?${keys.join(',')}`
      : `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

function groupByPattern(flows: FlowRecord[]): Map<string, EpochMs[]> {
  const byPattern = new Map<string, EpochMs[]>();
  for (const f of flows) {
    const p = urlPattern(f.url);
    const list = byPattern.get(p);
    if (list) list.push(f.at);
    else byPattern.set(p, [f.at]);
  }
  return byPattern;
}

function median(sorted: number[]): number {
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** 找出所有被判定為週期性的 URL pattern */
export function detectPeriodicPatterns(
  flows: FlowRecord[],
  opts: PeriodicOptions = {},
): Set<string> {
  const cfg = { ...DEFAULTS, ...opts };
  const periodic = new Set<string>();

  for (const [pattern, timesRaw] of groupByPattern(flows)) {
    if (timesRaw.length < cfg.minOccurrences) continue;

    const times = [...timesRaw].sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i += 1) {
      gaps.push((times[i] as number) - (times[i - 1] as number));
    }
    if (gaps.length < 2) continue;

    if (robustDispersion(gaps) <= cfg.maxCoefficientOfVariation) {
      periodic.add(pattern);
    }
  }

  return periodic;
}

/**
 * 穩健離散度 = median(|gap − medianGap|) / medianGap
 *
 * 為何不用標準差除以平均（一般的變異係數）：
 *   若某端點同時被輪詢與使用者操作使用，一次點擊會把
 *   原本 900ms 的間隔切成兩段（例如 400 + 500）。
 *   標準差對這種離群值極度敏感 —— 單一次點擊就足以
 *   讓整個序列不再被判定為週期性，該端點的輪詢因此
 *   全部湧入綁定結果。
 *
 *   實測（GUI 原型，2026-08-18）：
 *     此情況下 precision 從 100% 掉到 61.5%。
 *
 *   改用中位數為基礎的離散度後，少數離群值不影響判定：
 *   多數間隔仍是 900ms，中位數仍是 900ms，MAD 仍接近 0。
 *
 * 使用者觸發的請求則交由 isOffRhythm() 以相位偏移辨識，
 * 兩者分工：這裡判斷「這個端點有沒有節奏」，
 * isOffRhythm 判斷「這一次請求在不在節奏上」。
 */
function robustDispersion(gaps: number[]): number {
  const sorted = [...gaps].sort((a, b) => a - b);
  const med = median(sorted);
  if (med <= 0) return Number.POSITIVE_INFINITY;
  const deviations = gaps.map((g) => Math.abs(g - med)).sort((a, b) => a - b);
  return median(deviations) / med;
}

/** 一個 pattern 的節奏：以 anchorMs 為基準，每 gapMs 發生一次 */
export type Schedule = { anchorMs: EpochMs; gapMs: number };

/**
 * 擬合各 pattern 的節奏。
 *
 * 與 detectPeriodicPatterns 的差別：
 *   前者只回答「這個 pattern 是不是週期性的」，
 *   本函式進一步給出「它的節奏是什麼」，
 *   使我們能判斷「某一次請求是否落在節奏上」。
 *
 * 用 median 計算間隔，因為它對少數離群值穩健 ——
 * 而「使用者觸發的請求混入輪詢序列」正好就是離群值。
 *
 * anchor 的選法：
 *   逐一試每個時間點作為基準，選總相位誤差最小者。
 *   若直接用第一個時間點，而它剛好是使用者觸發的請求，
 *   整個節奏會偏移。
 */
export function fitSchedules(
  flows: FlowRecord[],
  opts: PeriodicOptions = {},
): Map<string, Schedule> {
  const cfg = { ...DEFAULTS, ...opts };
  const periodic = detectPeriodicPatterns(flows, opts);
  const out = new Map<string, Schedule>();

  for (const [pattern, timesRaw] of groupByPattern(flows)) {
    if (!periodic.has(pattern)) continue;
    if (timesRaw.length < cfg.minOccurrences) continue;

    const times = [...timesRaw].sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i += 1) {
      gaps.push((times[i] as number) - (times[i - 1] as number));
    }
    const gapMs = median([...gaps].sort((a, b) => a - b));
    if (gapMs <= 0) continue;

    let bestAnchor = times[0] as EpochMs;
    let bestError = Number.POSITIVE_INFINITY;

    for (const candidate of times) {
      let total = 0;
      for (const t of times) {
        const k = Math.round((t - candidate) / gapMs);
        total += Math.abs(t - (candidate + k * gapMs));
      }
      if (total < bestError) {
        bestError = total;
        bestAnchor = candidate;
      }
    }

    out.set(pattern, { anchorMs: bestAnchor, gapMs });
  }

  return out;
}

/**
 * 判斷某個時間點是否「不在節奏上」。
 *
 * 核心觀察：
 *   輪詢維持穩定節奏。使用者觸發的請求會出現在兩次排程之間，
 *   造成明顯的相位偏移。
 *
 * 這讓「輪詢與點擊共用同一端點」的情境可以被區分 ——
 * 而那正是 urlPattern 無能為力的地方（S1 的 c9 案例）。
 */
export const DEFAULT_RHYTHM_TOLERANCE = 0.25;

export function isOffRhythm(
  at: EpochMs,
  schedule: Schedule,
  tolerance = DEFAULT_RHYTHM_TOLERANCE,
): boolean {
  const k = Math.round((at - schedule.anchorMs) / schedule.gapMs);
  const predicted = schedule.anchorMs + k * schedule.gapMs;
  return Math.abs(at - predicted) > schedule.gapMs * tolerance;
}
