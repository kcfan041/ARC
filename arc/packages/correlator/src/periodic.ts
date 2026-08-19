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

const DEFAULTS: Required<PeriodicOptions> = {
  minOccurrences: 3,
  maxCoefficientOfVariation: 0.35,
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

    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (mean <= 0) continue;

    const variance =
      gaps.reduce((acc, g) => acc + (g - mean) ** 2, 0) / gaps.length;
    const cv = Math.sqrt(variance) / mean;

    if (cv <= cfg.maxCoefficientOfVariation) periodic.add(pattern);
  }

  return periodic;
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
