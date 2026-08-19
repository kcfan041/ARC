/**
 * 統一時基
 *
 * 對應 SPIKES.md S1 的前置問題。
 *
 * 問題：
 *   CDP  Network.requestWillBeSent.timestamp  單調時鐘（秒），非 wall clock
 *        Network.requestWillBeSent.wallTime   Unix epoch（秒）
 *   注入腳本  Date.now()        wall clock（毫秒）
 *            performance.now()  頁面載入起算，每次導航歸零 → 不可用
 *
 * 決定：
 *   一律以 Unix epoch 毫秒（Date.now() 的單位）為統一時基。
 *   CDP 側優先使用 wallTime × 1000。
 *   若某事件只有 monotonic timestamp，用校準點換算。
 *
 * 為何重要：
 *   時基若偏移 100ms，N=200ms 的時間窗量測結果即失真。
 *   因此策略實作前必須先驗證此模組（見 spike-s1 的 clock 驗證）。
 */

/** Unix epoch 毫秒。全系統唯一的時間單位。 */
export type EpochMs = number;

/**
 * CDP monotonic timestamp（秒）與 wall clock 的校準點。
 *
 * CDP 的 monotonic timestamp 原點不保證與任何已知時鐘對齊，
 * 因此需要至少一組同時取得的 (monotonic, wall) 配對來建立換算關係。
 */
export type ClockCalibration = {
  /** CDP monotonic timestamp（秒） */
  cdpMonotonicSec: number;
  /** 對應的 Unix epoch 毫秒 */
  epochMs: EpochMs;
};

/** 將 CDP 的 wallTime（Unix epoch 秒）轉為統一時基。 */
export function wallTimeToEpochMs(wallTimeSec: number): EpochMs {
  return Math.round(wallTimeSec * 1000);
}

/**
 * 用校準點將 CDP monotonic timestamp 換算為統一時基。
 *
 * 僅用於「只有 monotonic timestamp、沒有 wallTime」的事件
 * （例如 Network.responseReceived、Network.loadingFinished）。
 */
export function monotonicToEpochMs(
  monotonicSec: number,
  cal: ClockCalibration,
): EpochMs {
  const deltaMs = (monotonicSec - cal.cdpMonotonicSec) * 1000;
  return Math.round(cal.epochMs + deltaMs);
}

/**
 * 從一組校準樣本中挑出最可信的一組。
 *
 * 每個樣本是「同一個事件同時具備 monotonic 與 wall time」時取得的。
 * 取中位數以降低單一離群值的影響。
 */
export function pickCalibration(
  samples: ClockCalibration[],
): ClockCalibration | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort(
    (a, b) =>
      a.epochMs - a.cdpMonotonicSec * 1000 - (b.epochMs - b.cdpMonotonicSec * 1000),
  );
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * 量化時基一致性。
 *
 * 對每個樣本計算「用校準點換算出的 epochMs」與「實際 epochMs」的差距。
 * 若最大誤差超過容許值，代表時基不可信，量測結果無效。
 */
export function measureClockSkew(
  samples: ClockCalibration[],
  cal: ClockCalibration,
): { maxAbsErrorMs: number; medianAbsErrorMs: number; n: number } {
  if (samples.length === 0) {
    return { maxAbsErrorMs: 0, medianAbsErrorMs: 0, n: 0 };
  }
  const errors = samples
    .map((s) => Math.abs(monotonicToEpochMs(s.cdpMonotonicSec, cal) - s.epochMs))
    .sort((a, b) => a - b);
  return {
    maxAbsErrorMs: errors[errors.length - 1] ?? 0,
    medianAbsErrorMs: errors[Math.floor(errors.length / 2)] ?? 0,
    n: errors.length,
  };
}

/** 時基誤差的容許上限。超過此值則 S1 量測結果不可信。 */
export const CLOCK_SKEW_TOLERANCE_MS = 50;
