import type { EpochMs } from './time.js';

/**
 * Network Flow 記錄
 *
 * 命名沿用 mitmproxy 的 Flow 概念（原規格書 §48）。
 *
 * 注意：initiator 只有 CDP 提供，Playwright 的 page.on('request')
 * 不含 initiator stack。因此 Network 收集必須走 CDP。
 */

export type InitiatorType =
  | 'parser'
  | 'script'
  | 'preload'
  | 'SignedExchange'
  | 'preflight'
  | 'other';

export type CallFrame = {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
};

export type InitiatorStack = {
  callFrames: CallFrame[];
  /** async 邊界之外的上層 stack，需開啟 setAsyncCallStackDepth 才有 */
  parent?: InitiatorStack;
};

export type FlowInitiator = {
  type: InitiatorType;
  stack?: InitiatorStack;
  /** parser 類型才有：觸發載入的文件 URL */
  url?: string;
  lineNumber?: number;
};

export type FlowRecord = {
  /** flow_1, flow_2, ... */
  id: string;
  /** CDP requestId。redirect 會共用同一個，需注意去重 */
  requestId: string;
  url: string;
  method: string;
  resourceType?: string;
  /** 統一時基（Unix epoch 毫秒） */
  at: EpochMs;
  initiator: FlowInitiator;
  /** redirect 鏈中的第幾個，0 為原始請求 */
  redirectIndex: number;
  /**
   * fixture 用來標記自身身分的記號，僅供 S1 量測使用。
   * 從 URL query 中的 marker 參數取得。
   */
  marker?: string;
};

/** 從 URL 取出 fixture 標記（僅 S1 使用） */
export function extractMarker(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('marker') ?? undefined;
  } catch {
    return undefined;
  }
}
