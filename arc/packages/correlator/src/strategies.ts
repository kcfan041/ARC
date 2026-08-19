import type {
  ActionRecord,
  Binding,
  FlowRecord,
  StrategyName,
} from '@arc/core-model';
import {
  detectPeriodicPatterns,
  fitSchedules,
  isOffRhythm,
  urlPattern,
} from './periodic.js';

/**
 * 三種 Action ↔ Network 綁定策略
 *
 * 對應 SPIKES.md S1.3。三者同時執行以便對照。
 *
 *   A  純時間窗
 *   B  A + initiator 過濾
 *   C  B + 週期性偵測
 *
 * 共同前提：一個 flow 只綁給「最接近它的前一個 action」。
 * 若允許一個 flow 綁給多個 action，c7（快速連點）的
 * precision 會被嚴重高估。
 */

export type BindOptions = {
  windowMs: number;
  /** vendor 檔案的判定規則，策略 B 使用 */
  vendorPatterns?: RegExp[];
  /**
   * 節奏容許度，策略 D 使用。
   * 請求偏離預測時間超過 gapMs × tolerance 才視為使用者觸發。
   * 越小越容易判定為「使用者觸發」（recall 上升、precision 下降）。
   */
  rhythmTolerance?: number;
};

const DEFAULT_VENDOR: RegExp[] = [
  /\/node_modules\//,
  /\/vendor[.-]/,
  /\/(chunk-)?vendors?[.-~]/,
  /\/(react|vue|angular|jquery|axios|lodash)[.-]/,
];

/** 找出時間上最接近且早於該 flow 的 action */
function nearestPrecedingAction(
  flow: FlowRecord,
  actions: ActionRecord[],
  windowMs: number,
): ActionRecord | undefined {
  let best: ActionRecord | undefined;
  for (const a of actions) {
    if (a.at > flow.at) continue;
    if (flow.at - a.at > windowMs) continue;
    if (!best || a.at > best.at) best = a;
  }
  return best;
}

function emptyBindings(
  actions: ActionRecord[],
  strategy: StrategyName,
  windowMs: number,
): Map<string, Binding> {
  const m = new Map<string, Binding>();
  for (const a of actions) {
    m.set(a.id, { actionId: a.id, flowIds: [], strategy, windowMs });
  }
  return m;
}

/** 策略 A：純時間窗 */
export function bindStrategyA(
  actions: ActionRecord[],
  flows: FlowRecord[],
  opts: BindOptions,
): Binding[] {
  const out = emptyBindings(actions, 'A-window', opts.windowMs);
  for (const f of flows) {
    const a = nearestPrecedingAction(f, actions, opts.windowMs);
    if (a) out.get(a.id)?.flowIds.push(f.id);
  }
  return [...out.values()];
}

/**
 * 判斷 initiator 是否應被排除。
 *
 * parser / preload / SignedExchange 代表這個請求來自
 * HTML 解析或預載，與使用者操作無關。
 */
function isNonUserInitiator(f: FlowRecord): boolean {
  return (
    f.initiator.type === 'parser' ||
    f.initiator.type === 'preload' ||
    f.initiator.type === 'SignedExchange'
  );
}

/**
 * 只保留 API 類型的請求。
 *
 * 加入此條件的原因（S1 實測發現）：
 *   由 JavaScript 動態注入的 <link rel=prefetch>，
 *   CDP 回報的 initiator.type 是 'script' 而非 'preload' ——
 *   因為它確實是腳本建立的。
 *   因此單靠 initiator.type 無法濾除這類預載。
 *   resourceType 才能區分（'Other' vs 'XHR'/'Fetch'）。
 *
 * 取捨：
 *   這會一併濾掉「點擊後載入圖片／影片」這類請求。
 *   對 MVP1 的用途（找出資料來源 API）是正確的取捨，
 *   但若日後要支援媒體資源追蹤，需開放此過濾條件。
 */
const API_RESOURCE_TYPES = new Set(['XHR', 'Fetch', 'EventSource', 'WebSocket']);

function isApiRequest(f: FlowRecord): boolean {
  // 沒有 resourceType 資訊時不過濾，避免誤殺
  if (!f.resourceType) return true;
  return API_RESOURCE_TYPES.has(f.resourceType);
}

/**
 * 判斷 stack 是否完全落在 vendor 檔案內。
 *
 * 注意這只是「輔助訊號」而非決定性依據：
 *   實務上多數 XHR 都經過 axios/fetch wrapper，
 *   最上層 frame 幾乎必然在 vendor 內。
 *   因此只有「所有 frame 都在 vendor 內」才排除。
 */
function isPureVendorStack(f: FlowRecord, vendor: RegExp[]): boolean {
  const frames = f.initiator.stack?.callFrames;
  if (!frames || frames.length === 0) return false;
  return frames.every((fr) => vendor.some((re) => re.test(fr.url)));
}

/** 策略 B：時間窗 + initiator 過濾 */
export function bindStrategyB(
  actions: ActionRecord[],
  flows: FlowRecord[],
  opts: BindOptions,
): Binding[] {
  const vendor = opts.vendorPatterns ?? DEFAULT_VENDOR;
  const out = emptyBindings(actions, 'B-initiator', opts.windowMs);

  for (const f of flows) {
    if (isNonUserInitiator(f)) continue;
    if (!isApiRequest(f)) continue;
    if (isPureVendorStack(f, vendor)) continue;
    const a = nearestPrecedingAction(f, actions, opts.windowMs);
    if (a) out.get(a.id)?.flowIds.push(f.id);
  }
  return [...out.values()];
}

/** 策略 C：B + 週期性偵測 */
export function bindStrategyC(
  actions: ActionRecord[],
  flows: FlowRecord[],
  opts: BindOptions,
): Binding[] {
  const vendor = opts.vendorPatterns ?? DEFAULT_VENDOR;
  const periodic = detectPeriodicPatterns(flows);
  const out = emptyBindings(actions, 'C-periodic', opts.windowMs);

  for (const f of flows) {
    if (isNonUserInitiator(f)) continue;
    if (!isApiRequest(f)) continue;
    if (isPureVendorStack(f, vendor)) continue;
    if (periodic.has(urlPattern(f.url))) continue;
    const a = nearestPrecedingAction(f, actions, opts.windowMs);
    if (a) out.get(a.id)?.flowIds.push(f.id);
  }
  return [...out.values()];
}

/**
 * 策略 D：B + 節奏相位判定
 *
 * 與 C 的差別：
 *   C  只要 pattern 被判定為週期性，就整組排除
 *      → 若輪詢與使用者操作共用同一端點，操作也一併被排除
 *      → S1 的 c9 案例即因此漏掉
 *
 *   D  改為逐一判斷「這一次請求是否落在節奏上」
 *      → 落在節奏上 = 輪詢，排除
 *      → 偏離節奏   = 使用者觸發，保留
 *
 * 代價：
 *   若使用者操作恰好與輪詢重合（機率約為 tolerance × 2），
 *   仍會被誤判為輪詢。這是無法完全消除的模糊地帶。
 */
export function bindStrategyD(
  actions: ActionRecord[],
  flows: FlowRecord[],
  opts: BindOptions,
): Binding[] {
  const vendor = opts.vendorPatterns ?? DEFAULT_VENDOR;
  const schedules = fitSchedules(flows);
  const out = emptyBindings(actions, 'D-rhythm', opts.windowMs);

  for (const f of flows) {
    if (isNonUserInitiator(f)) continue;
    if (!isApiRequest(f)) continue;
    if (isPureVendorStack(f, vendor)) continue;

    const sched = schedules.get(urlPattern(f.url));
    // 有節奏且落在節奏上 → 判定為輪詢
    if (sched && !isOffRhythm(f.at, sched, opts.rhythmTolerance)) continue;

    const a = nearestPrecedingAction(f, actions, opts.windowMs);
    if (a) out.get(a.id)?.flowIds.push(f.id);
  }
  return [...out.values()];
}

export const STRATEGIES: Record<
  StrategyName,
  (a: ActionRecord[], f: FlowRecord[], o: BindOptions) => Binding[]
> = {
  'A-window': bindStrategyA,
  'B-initiator': bindStrategyB,
  'C-periodic': bindStrategyC,
  'D-rhythm': bindStrategyD,
};
